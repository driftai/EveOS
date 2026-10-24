#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const runtimeConfig = require('../runtime-config');
const { gitState } = require('../dex/post-idle-maintenance');
const { readLocalAuth } = require('../dex/task-completion-local-auth');
const { sourceIdentity } = require('../dex/tlo-production-activation');
const { STAGES, signCommand, inspectPrivateStorage } = require('../dex/tlo-activation-runner-gate');

const BRANCH = 'eve/nexus-machine-spaces';
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) args._.push(value);
    else {
      const key = value.slice(2), next = argv[i + 1];
      if (next == null || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
    }
  }
  return args;
}
function git(...args) {
  return execFileSync('git', args, { cwd: runtimeConfig.EVEOS_ROOT,
    encoding: 'utf8', timeout: 5_000, windowsHide: true }).trim();
}
async function diagnostics(fetchImpl = fetch, timeoutMs = 2_500) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(runtimeConfig.urls().diagnostics,
      { cache: 'no-store', signal: controller.signal });
    if (!response.ok) fail('TLO_ACTIVATION_RUNTIME_UNAVAILABLE', `Nexus diagnostics returned HTTP ${response.status}.`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function processIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) return { present: false };
  if (platform !== 'win32') {
    try { process.kill(Number(pid), 0); return { present: true, pid: Number(pid), commandMatches: true }; }
    catch { return { present: false, pid: Number(pid) }; }
  }
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" -ErrorAction SilentlyContinue;`
    + `if($p){[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;name=[string]$p.Name;command=[string]$p.CommandLine;created=[string]$p.CreationDate}|ConvertTo-Json -Compress}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return { present: false, pid: Number(pid) };
  const info = JSON.parse(String(result.stdout).trim());
  return { present: true, pid: info.pid, parentPid: info.parentPid,
    executable: path.basename(info.name || ''), created: info.created || null,
    commandMatches: /(?:^|[\\/])server\.js(?:\s|$|\")/i.test(String(info.command || '')) };
}
function pendingFrom(report = {}) {
  const control = report.controlPlane || {}, orchestration = report.orchestration || {};
  return { providerControls: Number(control.providerControlPending || 0),
    targetOperations: Number(control.targetOperationsPending || 0),
    controlReceipts: Number(control.controlReceiptsPending || 0),
    recoveryRooms: Number(report.recoveryRooms || orchestration.recoveryRooms?.length || 0),
    pendingRooms: Number(orchestration.pendingRooms?.length || 0),
    queuedIncoming: (orchestration.queuedIncoming || []).reduce((sum, item) => sum + Number(item.queued || 0), 0),
    activeTurn: orchestration.active ? 1 : 0 };
}
async function collectInventory({ fetchImpl = fetch } = {}) {
  const source = sourceIdentity(), repo = gitState(), remote = git('rev-parse', `origin/${BRANCH}`);
  const report = await diagnostics(fetchImpl), pending = pendingFrom(report);
  const server = processIdentity(report.serverPid), supervisor = processIdentity(report.supervisorPid);
  const privateStorage = inspectPrivateStorage(runtimeConfig.dataDir());
  const tlo = report.tloBackend || {}, sourceLoaded = tlo.source?.fingerprint === source.fingerprint;
  const cleanPending = Object.values(pending).every((value) => value === 0);
  const readyForDeployment = repo.branch === BRANCH && repo.head === remote && !repo.dirty
    && report.dexRooms === 14 && cleanPending && server.present && server.commandMatches
    && supervisor.present && privateStorage.secure === true
    && !tlo.uncertain && !tlo.handoff && tlo.deployment?.active !== true;
  return { schema: 'eveos.tlo-activation-inventory.v1', branch: repo.branch, head: repo.head,
    remoteHead: remote, clean: !repo.dirty, protocolVersion: source.protocolVersion,
    sourceFingerprint: source.fingerprint, sourceLoaded, serverSessionId: report.serverSessionId,
    serverPid: report.serverPid, supervisorPid: report.supervisorPid, server, supervisor,
    dexRooms: report.dexRooms, pending, privateStorage,
    tlo: { source: tlo.source || null, deployment: tlo.deployment || null,
      owner: tlo.owner || null, uncertain: !!tlo.uncertain, handoff: tlo.handoff || null,
      firstInference: tlo.firstInference || null, readiness: tlo.readiness || null },
    readyForDeployment };
}
function approvalText(stage, inventory) {
  return `approve:${stage}:${inventory.head}:${inventory.sourceFingerprint.slice(0, 16)}`;
}
function connectAndExecute(command, url = runtimeConfig.urls().websocket, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url), timer = setTimeout(() => {
      settle(Object.assign(new Error('Activation runner timed out; outcome may be uncertain.'),
        { code: 'TLO_ACTIVATION_TIMEOUT' }));
      try { ws.close(); } catch {}
    }, timeoutMs);
    let hello = false, dispatched = false, done = false;
    const settle = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'tlo-activation-runner' })));
    ws.on('message', (raw) => {
      let message; try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'tlo_activation_hello' && !hello) {
        hello = true;
        if (message.serverSessionId !== command.serverSessionId || message.serverPid !== command.serverPid
            || message.sourceFingerprint !== command.sourceFingerprint) {
          clearTimeout(timer); settle(Object.assign(
            new Error('Activation runtime identity changed before dispatch.'),
            { code: 'TLO_ACTIVATION_RUNTIME_CHANGED' })); ws.close(); return;
        }
        dispatched = true;
        ws.send(JSON.stringify({ type: 'tlo_activation_execute', requestId: command.requestId,
          authorization: command }));
      } else if (message.type === 'tlo_activation_result' && message.requestId === command.requestId) {
        clearTimeout(timer);
        if (message.ok) settle(null, message);
        else settle(Object.assign(new Error(message.message || 'Activation stage failed.'),
          { code: message.code || 'TLO_ACTIVATION_FAILED' }));
        ws.close();
      }
    });
    ws.on('error', (error) => settle(error));
    ws.on('close', () => settle(Object.assign(
      new Error(dispatched ? 'Runner socket closed after dispatch; outcome is uncertain.'
        : 'Runner socket closed before authentication.'),
      { code: dispatched ? 'TLO_ACTIVATION_OUTCOME_UNCERTAIN' : 'TLO_ACTIVATION_SOCKET_CLOSED' })));
  });
}
async function waitForReplacement(previousSession, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const report = await diagnostics(fetch, 1_500); if (report.serverSessionId && report.serverSessionId !== previousSession) return report; }
    catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail('TLO_DEPLOYMENT_OUTCOME_UNCERTAIN', 'Managed restart did not produce a verified replacement; do not retry automatically.');
}
async function executeStage(stage, args, inventory = null) {
  inventory ||= await collectInventory();
  if (!STAGES.has(stage)) fail('TLO_ACTIVATION_BAD_STAGE', 'Unknown activation stage.');
  if (stage === 'deployment') {
    fail('TLO_DEPLOYMENT_COORDINATOR_UNQUALIFIED',
      'Deployment requires a separately qualified, exact-revision two-process coordinator.');
  }
  if (stage === 'deployment') {
    fail('TLO_DEPLOYMENT_COORDINATOR_UNQUALIFIED',
      'Deployment requires a separately qualified, exact-revision two-process coordinator.');
  }
  if (stage === 'deployment') {
    fail('TLO_DEPLOYMENT_COORDINATOR_UNQUALIFIED',
      'Deployment requires a separately qualified, exact-revision two-process coordinator.');
  }
  if (String(args.authorize || '') !== approvalText(stage, inventory)) {
    fail('TLO_ACTIVATION_EXPLICIT_APPROVAL_REQUIRED', `Require --authorize "${approvalText(stage, inventory)}".`);
  }
  const expected = { head: String(args['expected-head'] || ''),
    fingerprint: String(args['expected-fingerprint'] || ''), session: String(args['expected-session'] || ''),
    pid: Number(args['expected-pid']), rooms: Number(args['expected-rooms']) };
  if (stage !== 'deployment' && !inventory.sourceLoaded) {
    fail('TLO_ACTIVATION_SOURCE_NOT_LOADED', 'Production service has not loaded the exact published source.');
  }
  if (expected.head !== inventory.head || expected.fingerprint !== inventory.sourceFingerprint
      || expected.session !== inventory.serverSessionId || expected.pid !== inventory.serverPid
      || expected.rooms !== inventory.dexRooms || !inventory.readyForDeployment) {
    fail('TLO_ACTIVATION_EXPECTATION_MISMATCH', 'Exact source/runtime expectations or deployment readiness failed.');
  }
  const payload = stage === 'first-inference' ? { requestId: String(args['turn-request-id'] || ''),
    roomId: String(args['room-id'] || ''), sourceMessageId: String(args['source-message-id'] || '') } : {};
  const requestId = String(args['request-id'] || `tlo-activation-${randomUUID()}`);
  const command = signCommand(readLocalAuth(), { stage, requestId, expectedHead: inventory.head,
    sourceFingerprint: inventory.sourceFingerprint, serverSessionId: inventory.serverSessionId,
    serverPid: inventory.serverPid, expectedRooms: inventory.dexRooms, payload });
  const result = await connectAndExecute(command);
  if (stage !== 'deployment') return { result, inventory };
  const restart = spawnSync(process.execPath, ['tools/runtime/nexus-browser-runtime.mjs', 'restart'],
    { cwd: runtimeConfig.EVEOS_ROOT, encoding: 'utf8', timeout: 60_000, windowsHide: false });
  if (restart.status !== 0) fail('TLO_DEPLOYMENT_OUTCOME_UNCERTAIN', 'Managed Nexus restart failed; do not retry automatically.');
  const replacement = await waitForReplacement(inventory.serverSessionId);
  if (replacement.dexRooms !== inventory.dexRooms
      || replacement.tloBackend?.source?.fingerprint !== inventory.sourceFingerprint) {
    fail('TLO_DEPLOYMENT_REPLACEMENT_INVALID', 'Replacement runtime did not preserve rooms or exact source identity.');
  }
  return { result, inventory, replacement: { serverSessionId: replacement.serverSessionId,
    serverPid: replacement.serverPid, dexRooms: replacement.dexRooms } };
}
function printInventory(value, json = false) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(`TLO_ACTIVATION_INVENTORY_${value.readyForDeployment ? 'GO' : 'NO_GO'} head=${value.head.slice(0, 12)} fingerprint=${value.sourceFingerprint.slice(0, 16)} rooms=${value.dexRooms} pending=${Object.values(value.pending).reduce((a, b) => a + b, 0)} sourceLoaded=${value.sourceLoaded}`);
}
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), command = String(args._[0] || 'help'), stage = String(args._[1] || '');
  if (command === 'inventory') { printInventory(await collectInventory(), args.json === true); return; }
  if (command === 'plan') {
    const value = await collectInventory(); printInventory(value, args.json === true);
    for (const name of STAGES) console.log(`${name}: --authorize "${approvalText(name, value)}"`);
    return;
  }
  if (command === 'execute') {
    const outcome = await executeStage(stage, args);
    console.log(`TLO_ACTIVATION_STAGE_OK stage=${stage} request=${outcome.result.requestId || outcome.result.record?.requestId || 'recorded'}`);
    return;
  }
  console.log('Usage: tlo-activation-runner.js inventory [--json] | plan | execute <stage> --expected-head <sha> --expected-fingerprint <sha256> --expected-session <id> --expected-pid <pid> --expected-rooms 14 --authorize <exact-plan-text>');
}

if (require.main === module) main().catch((error) => {
  console.error(`TLO_ACTIVATION_RUNNER_FAILED ${error?.code || 'ERROR'}: ${error?.message || error}`);
  process.exitCode = 1;
});

module.exports = { BRANCH, parseArgs, diagnostics, processIdentity, pendingFrom,
  collectInventory, approvalText, connectAndExecute, executeStage };
