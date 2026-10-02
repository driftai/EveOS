'use strict';

const readline = require('node:readline/promises');
const core = require('./terminal-driver-core');
const validation = require('./terminal-driver-validation');
const processTools = require('./terminal-driver-process');
const doctor = require('./terminal-relay-doctor');

function failed(ctx) {
  return ctx.results.some((result) => result.status === 'FAIL');
}

async function waitForReconnect() {
  if (!process.stdin.isTTY) {
    const error = new Error('relay:dev needs an interactive terminal before the live App-Origin relay step.');
    error.code = 'TERMINAL_RELAY_DEV_INTERACTIVE_REQUIRED';
    throw error;
  }
  console.log('\nReconnect/select the exact ChatGPT App conversation in Base Mode, then press Enter.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { await rl.question('> '); } finally { rl.close(); }
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
    return { meta, ctx, doctor: null, relay: null };
  }

  const restart = await processTools.runNpm(ctx, ['run', 'restart'], 'verified Nexus restart');
  if (restart.status !== 'PASS') {
    console.error('\nrelay:dev stopped because the verified Nexus restart failed.');
    process.exitCode = 2;
    return { meta, ctx, doctor: null, relay: null };
  }

  await waitForReconnect();

  const report = await doctor.inspectBinding();
  console.log('');
  doctor.printDoctorReport(report);
  if (!report.ok) {
    console.error('\nrelay:dev will not send while Terminal Relay binding is unhealthy.');
    process.exitCode = 3;
    return { meta, ctx, doctor: report, relay: null };
  }

  const result = await core.runRelayAfterValidation(meta, ctx);
  return { ...result, doctor: report };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 2;
  });
}

module.exports = { failed, waitForReconnect, main };
