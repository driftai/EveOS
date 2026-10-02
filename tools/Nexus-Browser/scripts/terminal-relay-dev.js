'use strict';

const readline = require('node:readline/promises');
const core = require('./terminal-driver-core');
const validation = require('./terminal-driver-validation');
const processTools = require('./terminal-driver-process');
const doctor = require('./terminal-relay-doctor');
const appTargets = require('../app-targets/manager');
const appTargetBinding = require('../app-targets/app-target-binding');
const storage = require('./terminal-relay-storage');

function failed(ctx) {
  return ctx.results.some((result) => result.status === 'FAIL');
}

function manualConnectRequested(argv = process.argv.slice(2)) {
  return argv.includes('--manual-connect');
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

async function main(argv = process.argv.slice(2)) {
  const ctx = core.createContext(argv);
  let meta = { branch: '', head: '', dirty: false };
  try {
    meta = await validation.execute(ctx);
  } catch (error) {
    ctx.results.push({
      label: 'relay:dev validation',
      status: 'FAIL',
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      error: error?.stack || String(error)
    });
  }
  if (failed(ctx)) {
    console.error('\nrelay:dev stopped before restart because validation failed.');
    process.exitCode = 2;
    return { meta, ctx, doctor: null, relay: null, binding: null };
  }

  const restart = await processTools.runNpm(ctx, ['run', 'restart'], 'verified Nexus restart');
  if (restart.status !== 'PASS') {
    console.error('\nrelay:dev stopped because the verified Nexus restart failed.');
    process.exitCode = 2;
    return { meta, ctx, doctor: null, relay: null, binding: null };
  }

  let binding = null;
  if (manualConnectRequested(argv)) {
    await waitForReconnect();
  } else {
    try {
      binding = await autoConnect();
    } catch (error) {
      console.error('\nAutomatic App-Origin binding failed:', error.code || 'AUTO_BIND_FAILED');
      console.error(error.message);
      console.error('Use --manual-connect only when you intentionally want interactive Base Mode selection.');
      process.exitCode = 3;
      return { meta, ctx, doctor: null, relay: null, binding: null, error };
    }
  }

  const report = await doctor.inspectBinding();
  console.log('');
  doctor.printDoctorReport(report);
  if (!report.ok) {
    console.error('\nrelay:dev will not send while Terminal Relay binding is unhealthy.');
    process.exitCode = 3;
    return { meta, ctx, doctor: report, relay: null, binding };
  }

  const result = await core.runRelayAfterValidation(meta, ctx);
  return { ...result, doctor: report, binding };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 2;
  });
}

module.exports = {
  failed,
  manualConnectRequested,
  waitForReconnect,
  autoConnect,
  main
};
