'use strict';

const readline = require('node:readline/promises');
const core = require('./terminal-driver-core');
const validation = require('./terminal-driver-validation');
const processTools = require('./terminal-driver-process');
const doctor = require('./terminal-relay-doctor');
const appTargets = require('../app-targets/manager');
const appTargetBinding = require('../app-targets/app-target-binding');
const storage = require('./terminal-relay-storage');

const TOTAL_STEPS = 6;

function failed(ctx) {
  return ctx.results.some((result) => result.status === 'FAIL');
}

function manualConnectRequested(argv = process.argv.slice(2)) {
  return argv.includes('--manual-connect');
}

function createProgress(storageApi = storage) {
  const startedAt = new Date().toISOString();
  let current = {
    active: true,
    status: 'RUNNING',
    stage: 'validation',
    label: 'Validation',
    detail: 'Preparing repository checks.',
    step: 1,
    totalSteps: TOTAL_STEPS,
    startedAt,
    stageStartedAt: startedAt,
    etaKind: 'estimate',
    etaMs: 9000,
    targetClassId: 'app-origin',
    ownerPid: process.pid
  };

  function write(patch = {}) {
    current = { ...current, ...patch };
    storageApi.writeProgress(current);
    return current;
  }

  function stage(stageName, label, step, {
    detail = '', etaMs = null, etaKind = etaMs == null ? 'unknown' : 'estimate'
  } = {}) {
    return write({
      active: true,
      status: 'RUNNING',
      stage: stageName,
      label,
      detail,
      step,
      totalSteps: TOTAL_STEPS,
      stageStartedAt: new Date().toISOString(),
      etaMs,
      etaKind
    });
  }

  function fail(detail, code = null) {
    return write({
      active: false,
      status: 'FAILED',
      stage: 'failed',
      label: 'Stopped',
      detail: String(detail || 'Terminal Relay stopped.'),
      code,
      etaMs: 0,
      etaKind: 'none',
      finishedAt: new Date().toISOString()
    });
  }

  function complete(relay = {}) {
    return write({
      active: false,
      status: relay.status === 'PASS' || relay.status === 'LOCAL_ONLY' ? 'COMPLETE' : relay.status || 'COMPLETE',
      stage: 'complete',
      label: relay.status === 'LOCAL_ONLY' ? 'Local validation complete' : 'Relay complete',
      detail: relay.reason || 'Terminal Relay workflow completed.',
      step: TOTAL_STEPS,
      totalSteps: TOTAL_STEPS,
      etaMs: 0,
      etaKind: 'none',
      replyChars: Number(relay.replyLength || current.replyChars || 0),
      finishedAt: new Date().toISOString()
    });
  }

  write();
  return { write, stage, fail, complete, snapshot: () => ({ ...current }) };
}

function interruptActiveProgress(reason = 'process exit', storageApi = storage, pid = process.pid) {
  const current = storageApi.readProgress?.();
  if (!current?.active) return false;
  if (current.ownerPid != null && Number(current.ownerPid) !== Number(pid)) return false;
  storageApi.writeProgress({
    ...current,
    active: false,
    status: 'FAILED',
    stage: 'failed',
    label: 'Relay interrupted',
    detail: `relay:dev exited before final provider capture completed (${reason}). The accepted report was not resent.`,
    code: 'RELAY_PROCESS_INTERRUPTED',
    etaMs: 0,
    etaKind: 'none',
    finishedAt: new Date().toISOString()
  });
  return true;
}

async function waitForReconnect() {
  if (!process.stdin.isTTY) {
    const error = new Error(
      'relay:dev --manual-connect needs an interactive terminal before the live App-Origin relay step.'
    );
    error.code = 'TERMINAL_RELAY_DEV_INTERACTIVE_REQUIRED';
    throw error;
  }
  console.log('\nReconnect/select the exact ChatGPT App conversation in Base Mode, then press Enter.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { await rl.question('> '); } finally { rl.close(); }
}

async function autoConnect({
  appTargetsApi = appTargets,
  bindingApi = appTargetBinding,
  storageApi = storage
} = {}) {
  const liveTargets = await appTargetsApi.listAppTargets({ force: true });
  const result = bindingApi.restorePersistedBinding({
    selection: storageApi.readTargetSelection(),
    liveTargets,
    appTargetsApi,
    storage: storageApi,
    allowSingleTargetFallback: true,
    providerId: 'chatgpt-desktop'
  });
  if (!result?.binding) {
    const error = new Error('Automatic App-Origin binding did not produce a target.');
    error.code = 'AUTO_BIND_FAILED';
    throw error;
  }

  const identity = result.binding.concreteTargetIdentity || {};
  console.log('\n============================================================');
  console.log('AUTO APP-ORIGIN BIND');
  console.log('============================================================');
  console.log('Mode:', result.mode);
  console.log('Provider:', result.binding.providerName || result.binding.providerId);
  console.log('Target:', result.binding.title || result.binding.id);
  console.log('PID/HWND:',
    identity.processId || result.binding.pid || '—',
    '/',
    identity.windowHandle || result.binding.windowHandle || '—');
  console.log('Conversation proof:',
    identity.conversationTitle || identity.conversationAnchor ? 'PRESENT' : 'MISSING');
  console.log('Binding persisted: YES');
  return result;
}

function bindingProgress(bindingResult = {}) {
  const binding = bindingResult.binding || {};
  const identity = binding.concreteTargetIdentity || {};
  return {
    targetClassId: 'app-origin',
    targetId: binding.id || null,
    providerId: binding.providerId || null,
    providerName: binding.providerName || null,
    targetTitle: binding.title || null,
    pid: identity.processId || binding.pid || null,
    windowHandle: identity.windowHandle || binding.windowHandle || null,
    bindMode: bindingResult.mode || null
  };
}

async function main(argv = process.argv.slice(2)) {
  const progress = createProgress();
  const ctx = core.createContext(argv);
  ctx.onStepStart = ({ label }) => {
    const current = progress.snapshot();
    if (label === 'verified Nexus restart') {
      progress.stage('restart', 'Restarting Nexus', 2, {
        detail: 'Recycling the bridge under the existing supervisor.', etaMs: 7000
      });
    } else if (current.stage === 'validation') {
      progress.write({ detail: label });
    }
  };
  ctx.onStepFinish = (result) => {
    const current = progress.snapshot();
    if (current.stage === 'validation' && result?.label) {
      progress.write({ detail: `${result.status} · ${result.label}` });
    }
  };
  ctx.onNotice = (notice) => {
    const current = progress.snapshot();
    if (current.stage === 'validation' && notice?.label) {
      progress.write({ detail: `NOTICE · ${notice.label}` });
    }
  };
  ctx.onRelayEvent = (event = {}) => {
    if (event.type === 'target_verified') {
      progress.write({ detail: 'Exact native conversation verified; dispatch lease acquired.' });
    } else if (event.type === 'prompt_accepted') {
      progress.write({ detail: 'ChatGPT App accepted the sanitized report; waiting for reply.', accepted: true });
    } else if (event.type === 'response_partial') {
      progress.write({ detail: `Capturing provider reply · ${String(event.text || '').length} chars`,
        replyChars: String(event.text || '').length });
    } else if (event.type === 'response_final') {
      progress.write({ detail: `Final provider reply captured · ${String(event.text || '').length} chars`,
        replyChars: String(event.text || '').length });
    }
  };

  let meta = { branch: '', head: '', dirty: false };
  try {
    meta = await validation.execute(ctx);
  } catch (error) {
    ctx.results.push({
      label: 'relay:dev validation', status: 'FAIL', exitCode: null, durationMs: 0,
      stdout: '', stderr: '', error: error?.stack || String(error)
    });
  }
  if (failed(ctx)) {
    progress.fail('Validation failed before Nexus restart.', 'VALIDATION_FAILED');
    console.error('\nrelay:dev stopped before restart because validation failed.');
    process.exitCode = 2;
    return { meta, ctx, doctor: null, relay: null, binding: null };
  }

  progress.stage('restart', 'Restarting Nexus', 2, {
    detail: 'Validation passed; restarting the bridge.', etaMs: 7000
  });
  const restart = await processTools.runNpm(ctx, ['run', 'restart'], 'verified Nexus restart');
  if (restart.status !== 'PASS') {
    progress.fail('Verified Nexus restart failed.', 'RESTART_FAILED');
    console.error('\nrelay:dev stopped because the verified Nexus restart failed.');
    process.exitCode = 2;
    return { meta, ctx, doctor: null, relay: null, binding: null };
  }

  let binding = null;
  if (manualConnectRequested(argv)) {
    progress.stage('manual-connect', 'Waiting for Base Mode', 3, {
      detail: 'Manual target selection requested.', etaKind: 'user'
    });
    await waitForReconnect();
  } else {
    progress.stage('auto-bind', 'Auto-binding ChatGPT App', 3, {
      detail: 'Discovering and proving the exact native conversation.', etaMs: 3000
    });
    try {
      binding = await autoConnect();
      progress.write({
        ...bindingProgress(binding),
        detail: `Bound automatically · ${binding.mode}`
      });
    } catch (error) {
      progress.fail(error.message, error.code || 'AUTO_BIND_FAILED');
      console.error('\nAutomatic App-Origin binding failed:', error.code || 'AUTO_BIND_FAILED');
      console.error(error.message);
      console.error('Use --manual-connect only when you intentionally want interactive Base Mode selection.');
      process.exitCode = 3;
      return { meta, ctx, doctor: null, relay: null, binding: null, error };
    }
  }

  progress.stage('doctor', 'Verifying binding', 4, {
    detail: 'Checking PID/HWND and native conversation continuity.', etaMs: 2500
  });
  const report = await doctor.inspectBinding();
  console.log('');
  doctor.printDoctorReport(report);
  if (!report.ok) {
    progress.fail(`Binding unhealthy · ${report.binding}: ${report.reason}`, report.binding);
    console.error('\nrelay:dev will not send while Terminal Relay binding is unhealthy.');
    process.exitCode = 3;
    return { meta, ctx, doctor: report, relay: null, binding };
  }

  progress.write({ detail: 'Binding healthy; preparing sanitized provider payload.' });
  progress.stage('relay', 'Relaying to ChatGPT App', 5, {
    detail: 'Preparing provider transmission.', etaKind: 'provider'
  });
  const result = await core.runRelayAfterValidation(meta, ctx);
  progress.complete(result.relay);
  return { ...result, doctor: report, binding };
}

if (require.main === module) {
  let closing = false;
  const keepAlive = setInterval(() => {}, 1000);
  const stop = (signal, code) => {
    if (closing) return;
    closing = true;
    try { interruptActiveProgress(signal); } catch {}
    clearInterval(keepAlive);
    process.exit(code);
  };
  process.once('SIGINT', () => stop('SIGINT', 130));
  process.once('SIGTERM', () => stop('SIGTERM', 143));
  process.once('exit', () => {
    if (!closing) {
      try { interruptActiveProgress('process exit'); } catch {}
    }
  });
  main().catch((error) => {
    try { storage.writeProgress({ active: false, status: 'FAILED', stage: 'failed', label: 'Stopped',
      detail: error.message, code: error.code || 'UNHANDLED_ERROR', finishedAt: new Date().toISOString(), ownerPid: process.pid }); } catch {}
    console.error(error?.stack || error);
    process.exitCode = 2;
  }).finally(() => {
    clearInterval(keepAlive);
  });
}

module.exports = {
  failed,
  manualConnectRequested,
  createProgress,
  interruptActiveProgress,
  waitForReconnect,
  autoConnect,
  bindingProgress,
  main
};
