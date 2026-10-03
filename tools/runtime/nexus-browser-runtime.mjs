#!/usr/bin/env node
import {
  configureHeadedServices,
  ensureControlPlane,
  serviceStatus,
  startService,
  stopService,
} from './search-monitor-runtime.shared.mjs';

const command = String(process.argv[2] || 'help').toLowerCase();

function printStatus(status = {}) {
  console.log('NEXUS_BROWSER_RUNTIME_STATUS');
  console.log(`STATE ${status.state || 'unavailable'}`);
  console.log(`RUNNING ${status.running === true}`);
  console.log(`OWNED ${status.owned === true}`);
  console.log(`EXTENSION ${status.extensionConnected ? 'connected' : status.extensionReady ? 'ready/offline' : 'missing'}`);
  console.log(`TARGETS online=${Number(status.onlineTargets || 0)} local=${Number(status.localTargets || 0)} app=${Number(status.appTargets || 0)}`);
}

async function prepare() {
  const control = await ensureControlPlane();
  await configureHeadedServices(['nexusBrowser']);
  return control;
}

async function start() {
  const control = await prepare();
  const result = await startService('nexusBrowser');
  console.log(`NEXUS_BROWSER_RUNTIME_START control=${control.started ? 'started' : 'already-running'} service=${result.started ? 'started' : 'already-running'}`);
  printStatus(result.status);
  console.log('ISOLATION local-moe=untouched eveos-web=untouched gemini=untouched');
}

async function stop() {
  await ensureControlPlane();
  const result = await stopService('nexusBrowser');
  console.log('NEXUS_BROWSER_RUNTIME_STOP');
  printStatus(result.status);
  console.log('ISOLATION local-moe=untouched eveos-web=untouched gemini=untouched');
}

async function restart() {
  await ensureControlPlane();
  await configureHeadedServices(['nexusBrowser']);
  await stopService('nexusBrowser');
  const result = await startService('nexusBrowser');
  console.log('NEXUS_BROWSER_RUNTIME_RESTART');
  printStatus(result.status);
  console.log('ISOLATION local-moe=untouched eveos-web=untouched gemini=untouched');
}

async function status() {
  await ensureControlPlane();
  printStatus(await serviceStatus('nexusBrowser'));
}

function help() {
  console.log(`Nexus Browser isolated runtime

Commands:
  plan      Show the isolated service selection without starting anything.
  start     Start only Local Control (if needed) and Nexus Browser.
  status    Inspect Nexus Browser without starting Local MoE.
  stop      Stop only the verified EveOS-owned Nexus Browser runtime.
  restart   Restart only the verified EveOS-owned Nexus Browser runtime.
`);
}

async function main() {
  if (command === 'plan') {
    console.log('NEXUS_BROWSER_RUNTIME_PLAN');
    console.log('SERVICES nexusBrowser');
    console.log('ISOLATION local-moe=untouched eveos-web=untouched gemini=untouched');
  } else if (command === 'start') await start();
  else if (command === 'status') await status();
  else if (command === 'stop') await stop();
  else if (command === 'restart') await restart();
  else if (command === 'help' || command === '--help' || command === '-h') help();
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`NEXUS_BROWSER_RUNTIME_FAILED: ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});
