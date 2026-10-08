#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createManagedTerminalBroker } = require('../machine-spaces/managed-terminal-broker');
const { readDiagnostics, verdict } = require('./bridge-doctor');
const { runExtensionReload } = require('./dexctl');
const { runQualification } = require('./live-qualify');

const FOCUSED_TESTS = Object.freeze([
  'tests/machine-spaces-supervised-terminal.test.js',
  'tests/machine-spaces-security-matrix.test.js',
  'tests/machine-spaces-human-gate.test.js',
  'tests/machine-spaces-supervised-controller-safety.test.js'
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv = process.argv.slice(2)) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const warmTabRaw = value('--warm-tab-id');
  const warmTabId = warmTabRaw == null ? null : Number(warmTabRaw);
  if (warmTabRaw != null && (!Number.isInteger(warmTabId) || warmTabId <= 0)) {
    throw Object.assign(new Error('--warm-tab-id must be a positive numeric tab id.'), { code: 'QUALIFY_BAD_WARM_TAB' });
  }
  return {
    chatgptLive: argv.includes('--chatgpt-live'),
    skipFocused: argv.includes('--skip-focused'),
    skipWindowsLive: argv.includes('--skip-windows-live'),
    warmTabId,
    timeoutMs: Math.max(30000, Math.min(11 * 60 * 1000, Number(value('--timeout-ms') || 180000)))
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
}

function gitSnapshot() {
  const head = run('git', ['rev-parse', 'HEAD']);
  const status = run('git', ['status', '--porcelain']);
  return {
    head: head.status === 0 ? String(head.stdout || '').trim() : null,
    clean: status.status === 0 && !String(status.stdout || '').trim(),
    status: String(status.stdout || '').trim(),
    error: head.status === 0 && status.status === 0 ? null : String(head.stderr || status.stderr || '').trim()
  };
}

function focusedTests() {
  const result = run(process.execPath, ['--test', ...FOCUSED_TESTS]);
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    exitCode: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    tests: [...FOCUSED_TESTS]
  };
}

function assembleExtension() {
  const script = path.resolve(__dirname, '../../extensions/assemble.cjs');
  const result = run(process.execPath, [script, '--write']);
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    exitCode: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

function liveSafety(doctor) {
  const reasons = [];
  if (!doctor?.ok) reasons.push(...(doctor?.issues || ['bridge doctor did not pass']));
  if (Number(doctor?.recoveryRooms || 0) > 0) reasons.push('one or more Dex rooms are actively recovering');
  if (doctor?.orchestration?.recovery?.active) reasons.push('Dex orchestration recovery is active');
  if (Number(doctor?.controlPlane?.providerControlPending || 0) > 0) reasons.push('provider-control work is pending');
  if (Number(doctor?.controlPlane?.controlReceiptsPending || 0) > 0) reasons.push('provider-control receipts are pending');
  if (Number(doctor?.controlPlane?.targetOperationsPending || 0) > 0) reasons.push('target operations are pending');
  return { ok: reasons.length === 0, reasons };
}

function processAlive(pid) {
  if (!pid) return null;
  const checked = run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { exit 7 } else { exit 0 }`
  ]);
  return checked.status === 7;
}

function killWindowsProcessTree(pid) {
  if (!pid) return;
  run('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
}

async function shellProbe(broker, type, command, expected) {
  try {
    const target = broker.createSession({ type, cwd: process.cwd() });
    const result = await broker.run({
      targetId: target.id,
      requestId: `terminal-qualify-${type}`,
      command
    });
    broker.stopSession(target.id);
    const stdout = String(result.stdout || '').trim();
    return {
      status: result.state === 'completed' && result.exitCode === 0 && stdout.includes(expected) ? 'PASS' : 'FAIL',
      state: result.state,
      exitCode: result.exitCode,
      stdout,
      stderr: String(result.stderr || '').trim()
    };
  } catch (error) {
    return {
      status: error.code === 'MACHINE_SHELL_UNAVAILABLE' && type === 'pwsh' ? 'SKIP' : 'BLOCKED',
      code: error.code || error.name,
      reason: error.message
    };
  }
}

async function windowsTreeKillProbe() {
  const broker = createManagedTerminalBroker({ defaultCwd: process.cwd(), supervisedTimeoutMs: 60000 });
  let childPid = null;
  try {
    const target = broker.createSession({ type: 'powershell', cwd: process.cwd() });
    const command = [
      "$p = Start-Process -PassThru -WindowStyle Hidden",
      "powershell.exe",
      "-ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300';",
      "Write-Output ('CHILD_PID=' + $p.Id);",
      'Start-Sleep -Seconds 300'
    ].join(' ');
    const running = broker.runSupervised({
      targetId: target.id,
      processEpoch: target.processEpoch,
      requestId: 'terminal-qualify-windows-tree-kill',
      command,
      onData(event) {
        const match = String(event.text || '').match(/CHILD_PID=(\d+)/);
        if (match) childPid = Number(match[1]);
      }
    });
    for (let i = 0; i < 50 && !childPid; i += 1) await sleep(100);
    if (!childPid) {
      broker.interrupt(target.id);
      await running;
      return { status: 'FAIL', reason: 'Child PID was not observed before interrupt.' };
    }
    const interruptAccepted = broker.interrupt(target.id);
    const result = await running;
    await sleep(1000);
    const childAlive = processAlive(childPid);
    const targetBusy = broker.target(target.id)?.busy === true;
    return {
      status: interruptAccepted && result.state === 'outcome-unknown' && result.reason === 'interrupted'
        && childAlive === false && targetBusy === false ? 'PASS' : 'FAIL',
      interruptAccepted,
      state: result.state,
      reason: result.reason,
      childPid,
      childAlive,
      targetBusy
    };
  } finally {
    if (childPid && processAlive(childPid)) killWindowsProcessTree(childPid);
    broker.stopAll();
  }
}

async function windowsExitGraceProbe() {
  const broker = createManagedTerminalBroker({
    defaultCwd: process.cwd(), supervisedTimeoutMs: 60000, exitGraceMs: 750
  });
  let childPid = null;
  try {
    const target = broker.createSession({ type: 'powershell', cwd: process.cwd() });
    const command = [
      '$p = Start-Process -PassThru -NoNewWindow',
      'powershell.exe',
      "-ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30';",
      "Write-Output ('PIN_CHILD_PID=' + $p.Id);",
      'exit 0'
    ].join(' ');
    const started = Date.now();
    const result = await broker.runSupervised({
      targetId: target.id,
      processEpoch: target.processEpoch,
      requestId: 'terminal-qualify-windows-exit-grace',
      command,
      onData(event) {
        const match = String(event.text || '').match(/PIN_CHILD_PID=(\d+)/);
        if (match) childPid = Number(match[1]);
      }
    });
    const elapsedMs = Date.now() - started;
    const childAlive = processAlive(childPid);
    const targetBusy = broker.target(target.id)?.busy === true;
    return {
      status: result.state === 'completed' && result.exitCode === 0 && childPid
        && childAlive === true && targetBusy === false && elapsedMs >= 500 && elapsedMs < 10000 ? 'PASS' : 'FAIL',
      state: result.state,
      exitCode: result.exitCode,
      elapsedMs,
      childPid,
      childAlive,
      targetBusy
    };
  } finally {
    if (childPid && processAlive(childPid)) killWindowsProcessTree(childPid);
    broker.stopAll();
  }
}

async function windowsLive() {
  if (process.platform !== 'win32') return { status: 'SKIP', reason: 'Windows-only live qualification.' };
  const broker = createManagedTerminalBroker({ defaultCwd: process.cwd(), timeoutMs: 15000 });
  try {
    const shells = {
      cmd: await shellProbe(broker, 'cmd', 'echo NEXUS_CMD_OK', 'NEXUS_CMD_OK'),
      powershell: await shellProbe(broker, 'powershell', 'Write-Output NEXUS_WINDOWS_POWERSHELL_OK', 'NEXUS_WINDOWS_POWERSHELL_OK'),
      pwsh: await shellProbe(broker, 'pwsh', 'Write-Output NEXUS_PWSH_OK', 'NEXUS_PWSH_OK'),
      wsl: await shellProbe(broker, 'wsl', "printf 'NEXUS_WSL_OK\\n'", 'NEXUS_WSL_OK')
    };
    const requiredShellsPass = ['cmd', 'powershell', 'wsl'].every((key) => shells[key].status === 'PASS');
    const treeKill = await windowsTreeKillProbe();
    const exitGrace = await windowsExitGraceProbe();
    return {
      status: requiredShellsPass && treeKill.status === 'PASS' && exitGrace.status === 'PASS' ? 'PASS' : 'FAIL',
      shells,
      treeKill,
      exitGrace
    };
  } finally {
    broker.stopAll();
  }
}

async function doctorSnapshot() {
  try {
    const raw = await readDiagnostics();
    return verdict(raw, { serverLogAvailable: null });
  } catch (error) {
    return { ok: false, issues: [error.message], serverOffline: true };
  }
}

async function chatgptLive({ doctor, warmTabId, timeoutMs }) {
  const safety = liveSafety(doctor);
  if (!safety.ok) return { status: 'BLOCKED', reason: 'Unsafe to disturb provider state.', safety };
  const assembly = assembleExtension();
  if (assembly.status !== 'PASS') return { status: 'FAIL', assembly, reason: 'Extension assembly failed.' };
  const reload = await runExtensionReload();
  if (!reload?.ok) return { status: 'FAIL', assembly, reload, reason: reload?.message || 'Extension reload failed.' };
  const qualification = await runQualification({
    providerId: 'chatgpt',
    recoveryTarget: 'warm',
    warmTabId,
    timeoutMs
  });
  return {
    status: qualification.status,
    assembly,
    reload,
    noRefreshWarmTarget: qualification.postDispatchRecovery?.targetMode === 'preexisting-warm',
    qualification
  };
}

function overallStatus(report, options) {
  const sections = [report.focused, report.windows];
  if (options.chatgptLive) sections.push(report.chatgptLive);
  if (sections.some((entry) => entry?.status === 'FAIL')) return 'FAIL';
  if (sections.some((entry) => entry?.status === 'BLOCKED')) return 'BLOCKED';
  return 'PASS';
}

async function runQualificationReport(options = parseArgs()) {
  const report = {
    kind: 'machine-spaces-terminal-qualification',
    at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    git: gitSnapshot(),
    doctor: await doctorSnapshot(),
    focused: options.skipFocused ? { status: 'SKIP' } : focusedTests(),
    windows: options.skipWindowsLive ? { status: 'SKIP' } : await windowsLive(),
    chatgptLive: options.chatgptLive ? null : { status: 'SKIP', reason: 'Use --chatgpt-live to opt into the authenticated warm-tab proof.' },
    remaining: {
      exactOriginFinalization: 'PENDING_NORMAL_DEX_PROVENANCE_PROOF',
      managedEveSpawn: 'PENDING_NORMAL_DEX_PROVENANCE_PROOF',
      realAgentQuorum: 'PENDING_NORMAL_DEX_PROVENANCE_PROOF',
      externalTerminalAdapter: 'SOURCE_GAP'
    }
  };
  if (options.chatgptLive) report.chatgptLive = await chatgptLive({ doctor: report.doctor, ...options });
  report.status = overallStatus(report, options);
  return report;
}

async function main() {
  const options = parseArgs();
  const report = await runQualificationReport(options);
  process.stdout.write('MACHINE_SPACES_TERMINAL_QUALIFICATION_BEGIN\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('MACHINE_SPACES_TERMINAL_QUALIFICATION_END\n');
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'BLOCKED' ? 2 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write('MACHINE_SPACES_TERMINAL_QUALIFICATION_BEGIN\n');
    process.stdout.write(JSON.stringify({ status: 'FAIL', code: error.code || error.name, reason: error.message }, null, 2) + '\n');
    process.stdout.write('MACHINE_SPACES_TERMINAL_QUALIFICATION_END\n');
    process.exitCode = 1;
  });
}

module.exports = {
  FOCUSED_TESTS,
  parseArgs,
  liveSafety,
  gitSnapshot,
  focusedTests,
  assembleExtension,
  windowsLive,
  chatgptLive,
  runQualificationReport,
  main
};
