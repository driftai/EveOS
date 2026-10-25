#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const runtimeConfig = require('../runtime-config');
const { gitState } = require('../dex/post-idle-maintenance');
const { readLocalAuth } = require('../dex/task-completion-local-auth');
const { sourceIdentity } = require('../dex/tlo-production-activation');
const { createDurableTloOwnershipStore } = require('../dex/tlo-ownership-durable-store');
const { createTloConversationStore } = require('../dex/tlo-conversation-store');
const { STAGES, signCommand, inspectPrivateStorage } = require('../dex/tlo-activation-runner-gate');
const { roomIdentity, signDeploymentIntent,
  createDeploymentCoordinator } = require('../dex/tlo-deployment-coordinator');

const BRANCH = 'eve/nexus-machine-spaces';
const NEXUS_STATUS_TIMEOUT_MS = 15_000;
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
async function jsonEndpoint(url, { fetchImpl = fetch, method = 'GET', body = null,
  timeoutMs = 3_000, origin = null } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, cache: 'no-store', signal: controller.signal,
      headers: { ...(body == null ? {} : { 'Content-Type': 'application/json' }),
        ...(origin ? { Origin: origin } : {}) },
      ...(body == null ? {} : { body: JSON.stringify(body) }) });
    let payload = null; try { payload = await response.json(); } catch {}
    return { ok: response.ok && payload?.ok !== false, status: response.status, payload };
  } finally { clearTimeout(timer); }
}
function processCommandMatches(command, kind = 'nexus') {
  const patterns = { nexus: /(?:^|[\\/])server\.js(?:\s|$|\")/i,
    control: /(?:^|[\\/])eveos-control-helper\.py(?:\s|$|\")/i,
    supervisor: /(?:^|[\\/])bridge-supervisor\.js(?:\s|$|")/i,
    web: /(?:^|[\\/])python-server\.py(?:\s|$|\")/i };
  return (patterns[kind] || patterns.nexus).test(String(command || ''));
}
function processIdentity(pid, platform = process.platform, kind = 'nexus') {
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
    commandMatches: processCommandMatches(info.command, kind) };
}
function listenerPids(port, platform = process.platform) {
  if (platform === 'win32') {
    const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    const marker = `:${Number(port)}`;
    return [...new Set(String(result.stdout || '').split(/\r?\n/).filter((line) =>
      line.includes(marker) && /LISTENING/i.test(line)).map((line) => line.trim().split(/\s+/).at(-1))
      .filter((value) => /^\d+$/.test(value)).map(Number))].sort((a, b) => a - b);
  }
  const result = spawnSync('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'],
    { encoding: 'utf8', timeout: 5_000 });
  return [...new Set(String(result.stdout || '').split(/\s+/).filter((value) => /^\d+$/.test(value)).map(Number))]
    .sort((a, b) => a - b);
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
function readRoomSnapshot(file = path.join(runtimeConfig.dataDir(), 'dex-state.json'), io = fs) {
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64 * 1024 * 1024) {
    fail('TLO_DEPLOYMENT_ROOM_STATE_INVALID', 'Dex room state is not a bounded regular file.');
  }
  let value; try { value = JSON.parse(io.readFileSync(file, 'utf8')); }
  catch { fail('TLO_DEPLOYMENT_ROOM_STATE_INVALID', 'Dex room state cannot be decoded.'); }
  return roomIdentity(value);
}
function exists(file, io = fs) {
  try { io.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function inspectDurableTloDormancy(root = runtimeConfig.dataDir(), io = fs) {
  const unsafe = (code) => Object.freeze({ proven: false, state: 'unsafe', code });
  try {
    const activation = path.join(root, 'tlo-backend-activation.json');
    const ownershipDir = path.join(root, 'tlo-ownership');
    const conversationDir = path.join(root, 'tlo-conversations');
    if (exists(activation, io)) return unsafe('TLO_DEPLOYMENT_DURABLE_ACTIVATION_PRESENT');
    if (exists(path.join(ownershipDir, 'default.lock'), io)
        || exists(path.join(conversationDir, 'default.lock'), io)) {
      return unsafe('TLO_DEPLOYMENT_DURABLE_STATE_LOCKED');
    }
    const ownerStore = createDurableTloOwnershipStore({ dirPath: ownershipDir, io });
    const conversationStore = createTloConversationStore({ dirPath: conversationDir, io });
    const ownerRecord = ownerStore.read('default');
    const conversation = conversationStore.snapshot('default');
    if (exists(path.join(ownershipDir, 'default.lock'), io)
        || exists(path.join(conversationDir, 'default.lock'), io)
        || JSON.stringify(ownerStore.read('default')) !== JSON.stringify(ownerRecord)
        || JSON.stringify(conversationStore.snapshot('default')) !== JSON.stringify(conversation)) {
      return unsafe('TLO_DEPLOYMENT_DURABLE_STATE_CHANGED');
    }
    const owner = ownerRecord?.state || null;
    let state;
    if (!ownerRecord && !conversation) state = 'uninitialized';
    else if (owner?.owner?.kind === 'browser' && owner.handoff === null && owner.turn === null
        && Number.isSafeInteger(owner.generation) && owner.generation > 0
        && conversation?.generation === owner.generation && conversation.pending === null) {
      state = 'browser-idle';
    } else return unsafe('TLO_DEPLOYMENT_DURABLE_STATE_NOT_DORMANT');
    const summary = { state, ownerKind: owner?.owner?.kind || null,
      generation: owner?.generation || 0, ownerRevision: ownerRecord?.revision || null,
      conversationRevision: conversation?.revision || null };
    return Object.freeze({ proven: true, ...summary,
      digest: createHash('sha256').update(JSON.stringify(summary)).digest('hex') });
  } catch (error) {
    return unsafe(String(error?.code || 'TLO_DEPLOYMENT_DURABLE_STATE_INVALID').slice(0, 96));
  }
}
function deploymentDormant(tlo, sourceLoaded, durableTloDormancy) {
  const disabled = tlo?.deployment?.state === 'disabled'
    || (!sourceLoaded && tlo?.deployment == null);
  return disabled && tlo?.uncertain !== true && !tlo?.handoff
    && durableTloDormancy?.proven === true;
}
async function localRuntimeInventory({ fetchImpl = fetch, listeners = listenerPids,
  inspectProcess = processIdentity, nexusStatusTimeoutMs = NEXUS_STATUS_TIMEOUT_MS } = {}) {
  const controlPort = runtimeConfig.portFor('GEMINI_CONTROL_PORT');
  const webPort = runtimeConfig.portFor('EVEOS_WEB_PORT');
  const controlBase = `http://127.0.0.1:${controlPort}`;
  const webBase = `http://127.0.0.1:${webPort}`;
  const [control, webStatus, nexus] = await Promise.all([
    jsonEndpoint(`${controlBase}/api/control-plane/health`, { fetchImpl }),
    jsonEndpoint(`${controlBase}/api/eveos-server/status?port=${webPort}`, { fetchImpl }),
    jsonEndpoint(`${controlBase}/api/nexus-browser/status`, { fetchImpl,
      timeoutMs: nexusStatusTimeoutMs }),
  ]);
  const before = await jsonEndpoint(`${webBase}/api/status`, { fetchImpl });
  const modular = await jsonEndpoint(`${webBase}/api/eve-state/modular/path`, { fetchImpl, timeoutMs: 5_000 });
  const after = await jsonEndpoint(`${webBase}/api/status`, { fetchImpl });
  const web = webStatus.payload || {}, direct = after.payload || {};
  const pids = Array.isArray(web.pids) ? web.pids.map(Number).filter(Number.isSafeInteger) : [];
  const listenersPresent = pids.length > 0
    && pids.every((pid) => inspectProcess(pid, process.platform, 'web').commandMatches);
  const controlPids = listeners(controlPort);
  const controlIdentity = controlPids.length === 1
    ? inspectProcess(controlPids[0], process.platform, 'control') : { present: false };
  return {
    control: { ...(control.payload || {}), verified: control.ok
      && control.payload?.service === 'eveos-control-plane', pid: controlPids[0] || null,
      identityVerified: controlIdentity.present === true && controlIdentity.commandMatches === true },
    web: { ...web, port: webPort, modularRoot: String(modular.payload?.rootPath || ''),
      identityVerified: web.running === true && before.ok && after.ok && modular.ok
        && before.payload?.service === 'eveos-local-server'
        && before.payload?.instanceId === direct.instanceId && web.instanceId === direct.instanceId
        && web.sourceFingerprint === direct.sourceFingerprint && listenersPresent },
    nexus: nexus.payload || {},
  };
}
function runtimeOwnersValid(local, report) {
  return local?.control?.verified === true && local.control.identityVerified === true
    && local?.web?.identityVerified === true && local?.nexus?.owned === true
    && Number.isSafeInteger(report?.supervisorPid)
    && local.nexus.supervisorPid === report.supervisorPid;
}
async function collectInventory({ fetchImpl = fetch } = {}) {
  const source = sourceIdentity(), repo = gitState(), remote = git('rev-parse', `origin/${BRANCH}`);
  const report = await diagnostics(fetchImpl), pending = pendingFrom(report);
  const server = processIdentity(report.serverPid), supervisor = processIdentity(report.supervisorPid, process.platform, 'supervisor');
  const privateStorage = inspectPrivateStorage(runtimeConfig.dataDir());
  const local = await localRuntimeInventory({ fetchImpl });
  const rooms = readRoomSnapshot();
  const tlo = report.tloBackend || {}, sourceLoaded = tlo.source?.fingerprint === source.fingerprint;
  const durableTloDormancy = inspectDurableTloDormancy();
  const cleanPending = Object.values(pending).every((value) => value === 0);
  const readyForDeployment = repo.branch === BRANCH && repo.head === remote && !repo.dirty
    && report.dexRooms === 14 && cleanPending && server.present && server.commandMatches
    && supervisor.present && privateStorage.secure === true
    && rooms.count === report.dexRooms && runtimeOwnersValid(local, report)
    && deploymentDormant(tlo, sourceLoaded, durableTloDormancy);
  return { schema: 'eveos.tlo-activation-inventory.v1', branch: repo.branch, head: repo.head,
    remoteHead: remote, clean: !repo.dirty, protocolVersion: source.protocolVersion,
    sourceFingerprint: source.fingerprint, sourceLoaded, serverSessionId: report.serverSessionId,
    serverPid: report.serverPid, supervisorPid: report.supervisorPid, server, supervisor,
    dexRooms: report.dexRooms, roomIdentityDigest: rooms.digest, pending, privateStorage,
    control: local.control, web: local.web, nexus: local.nexus, durableTloDormancy,
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
async function restartViaLocalControl(service, webPort, fetchImpl = fetch) {
  const controlPort = runtimeConfig.portFor('GEMINI_CONTROL_PORT');
  const origin = `http://127.0.0.1:${webPort}`;
  const result = await jsonEndpoint(
    `http://127.0.0.1:${controlPort}/api/services/restart?port=${webPort}`,
    { fetchImpl, method: 'POST', body: { service }, timeoutMs: 120_000, origin });
  if (!result.payload) fail('TLO_DEPLOYMENT_CONTROL_RESPONSE_INVALID',
    `Local Control returned no lifecycle receipt for ${service}.`);
  return result.payload;
}
async function executeStage(stage, args, inventory = null, dependencies = {}) {
  const inventoryReader = dependencies.collectInventory || collectInventory;
  inventory ||= await inventoryReader();
  if (!STAGES.has(stage)) fail('TLO_ACTIVATION_BAD_STAGE', 'Unknown activation stage.');
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
  const requestId = String(args['request-id'] || `tlo-activation-${randomUUID()}`);
  if (stage === 'deployment') {
    const coordinator = dependencies.deploymentCoordinator || createDeploymentCoordinator({
      readSecret: () => readLocalAuth(), observe: inventoryReader,
      restartService: dependencies.restartService || restartViaLocalControl,
    });
    const intent = signDeploymentIntent(readLocalAuth(), inventory, requestId);
    return { result: await coordinator.execute(intent), inventory };
  }
  const payload = stage === 'first-inference' ? { requestId: String(args['turn-request-id'] || ''),
    roomId: String(args['room-id'] || ''), sourceMessageId: String(args['source-message-id'] || '') } : {};
  const command = signCommand(readLocalAuth(), { stage, requestId, expectedHead: inventory.head,
    sourceFingerprint: inventory.sourceFingerprint, serverSessionId: inventory.serverSessionId,
    serverPid: inventory.serverPid, expectedRooms: inventory.dexRooms, payload });
  const result = await connectAndExecute(command);
  return { result, inventory };
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

module.exports = { processCommandMatches, BRANCH, NEXUS_STATUS_TIMEOUT_MS, parseArgs, diagnostics, processIdentity, pendingFrom,
  listenerPids, readRoomSnapshot, inspectDurableTloDormancy, deploymentDormant,
  localRuntimeInventory, runtimeOwnersValid, collectInventory, approvalText,
  connectAndExecute, restartViaLocalControl, executeStage };
