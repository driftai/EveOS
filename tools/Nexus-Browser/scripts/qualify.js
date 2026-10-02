#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { dataDir } = require('../runtime-config');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(dataDir(), 'qualification');
const AREA_TESTS = {
  muse: ['tests/muse-input.test.js', 'tests/muse-submit.test.js', 'tests/muse-answer.test.js'],
  dex: ['tests/dex-protocol.test.js', 'tests/dex-provider-control.test.js', 'tests/dex-provider-control-bootstrap.test.js', 'tests/provider-control-receipt.test.js', 'tests/provider-control-origin-race.test.js', 'tests/dex-provider-control-nested.test.js', 'tests/provider-adapter-freshness.test.js', 'tests/dex-state-sync.test.js', 'tests/dex-state-store.test.js', 'tests/dex-runtime-client.test.js', 'tests/server-scheduler.test.js'],
  recovery: ['tests/server-scheduler-recovery.test.js', 'tests/server-state-merge.test.js', 'tests/antigravity-recovery-capture.test.js', 'tests/online-target-recovery.test.js'],
  extension: ['tests/extension-wiring.test.js', 'tests/online-target-recovery.test.js', 'tests/target-state.test.js', 'tests/dex-ui-ensure.test.js'],
  local: ['tests/local-targets.test.js', 'tests/antigravity-existing.test.js', 'tests/antigravity-recovery-capture.test.js'],
  'app-origin': [
    'tests/chatgpt-windows-app.test.js', 'tests/chatgpt-windows-composer-shape.test.js',
    'tests/chatgpt-windows-codex-surface.test.js', 'tests/chatgpt-windows-frame-origin.test.js',
    'tests/chatgpt-windows-conversation.test.js',
    'tests/chatgpt-windows-title.test.js', 'tests/chatgpt-windows-identity.test.js',
    'tests/chatgpt-windows-full-reply.test.js', 'tests/chatgpt-windows-live-shape.test.js',
    'tests/winapp-runner-retry.test.js',
    'tests/app-origin-live-contract.test.js', 'tests/app-origin-manager.test.js',
    'tests/app-origin-passive-watcher.test.js', 'tests/app-origin-server.test.js', 'tests/app-origin-dex.test.js',
    'tests/app-origin-recovery.test.js', 'tests/target-classes-ui.test.js',
    'tests/chatgpt-app-mirror.test.js', 'tests/chatgpt-app-mirror-routing.test.js',
    'tests/nexus-host-lifecycle.test.js', 'tests/nexus-control-ownership.test.js',
    'tests/workspace-handoff.test.js', 'tests/workspace-handoff-wiring.test.js',
    'tests/workspace-view-state.test.js',
    'tests/server-socket-safety.test.js', 'tests/ui-socket.test.js',
    'tests/supervisor-health.test.js', 'tests/restart-bridge.test.js', 'tests/startup-scripts.test.js'
  ],
  resilience: [
    'tests/muse-input.test.js', 'tests/muse-submit.test.js', 'tests/chatgpt-input.test.js',
    'tests/server-scheduler.test.js', 'tests/server-scheduler-recovery.test.js', 'tests/server-scheduler-state.test.js',
    'tests/server-state-merge.test.js', 'tests/server-local-relay.test.js', 'tests/dex-runtime-client.test.js', 'tests/dex-state-sync.test.js', 'tests/dex-state-store.test.js',
    'tests/dex-provider-control-routing.test.js', 'tests/dex-provider-control-handoff.test.js', 'tests/provider-control-receipt.test.js', 'tests/provider-control-origin-race.test.js', 'tests/dex-provider-control-nested.test.js', 'tests/online-target-recovery.test.js',
    'tests/target-state.test.js', 'tests/target-resurrection.test.js', 'tests/adapter-readiness-cache.test.js',
    'tests/dex-ui-ensure.test.js', 'tests/dex-failure-policy.test.js', 'tests/dex-turn-ledger.test.js',
    'tests/dex-state-repair.test.js', 'tests/server-durability.test.js', 'tests/dex-server-routing.test.js',
    'tests/nexus-host-lifecycle.test.js', 'tests/nexus-control-ownership.test.js',
    'tests/workspace-handoff.test.js', 'tests/workspace-handoff-wiring.test.js',
    'tests/workspace-view-state.test.js', 'tests/server-socket-safety.test.js', 'tests/ui-socket.test.js',
    'tests/supervisor-health.test.js', 'tests/ws-heartbeat.test.js',
    'tests/antigravity-async-snapshot.test.js', 'tests/antigravity-recovery-capture.test.js',
    'tests/deterministic-ops.test.js',
    'tests/provider-contract.test.js', 'tests/provider-manifest.test.js', 'tests/qualification-provider-adapters.test.js',
    'tests/provider-adapter-freshness.test.js', 'tests/relay-latency.test.js', 'tests/failure-evidence.test.js', 'tests/disposable-room-cleanup.test.js'
  ]
};

function parseArgs(argv) {
  const args = [...argv];
  const options = { area: 'dex', full: false, verify: false };
  while (args.length) {
    const token = args.shift();
    if (token === '--area') options.area = String(args.shift() || '');
    else if (token === '--full') options.full = true;
    else if (token === '--verify') options.verify = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  if (!AREA_TESTS[options.area]) throw new Error(`Unknown area: ${options.area}. Use ${Object.keys(AREA_TESTS).join(', ')}.`);
  return options;
}

function run(label, command, args, log) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell: false });
  log.push(`\n===== ${label} =====\n`);
  log.push(result.stdout || '');
  log.push(result.stderr || '');
  return { label, code: result.status ?? 1, ms: Date.now() - started };
}

function commandForNpm() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}


function failureExcerpt(text, maxLines = 80) {
  const lines = String(text || '').split(/\r?\n/);
  let index = -1;
  const marker = /(not ok\b|AssertionError|ERR_ASSERTION|\bError:|# fail\b|\bfail \d+\b)/i;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (marker.test(lines[i])) { index = i; break; }
  }
  if (index < 0) return lines.filter(Boolean).slice(-maxLines);
  const start = Math.max(0, index - 12);
  const end = Math.min(lines.length, index + Math.max(20, maxLines - 12));
  return lines.slice(start, end).filter(Boolean).slice(0, maxLines);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const log = [];
  const stages = [];

  stages.push(run('file-size', process.execPath, ['tests/file-size.test.js'], log));
  if (stages.at(-1).code === 0) {
    stages.push(run(`focused:${options.area}`, process.execPath, ['--test', ...AREA_TESTS[options.area]], log));
  }
  if (options.full && !options.verify && stages.every((stage) => stage.code === 0)) {
    stages.push(run('npm-test', commandForNpm(), ['test'], log));
  }
  if (options.verify && stages.every((stage) => stage.code === 0)) {
    stages.push(process.platform === 'win32'
      ? run('VERIFY.bat', 'cmd.exe', ['/d', '/c', 'set NEXUS_BROWSER_NONINTERACTIVE=1&& VERIFY.bat'], log)
      : run('npm-test', commandForNpm(), ['test'], log));
  }

  const passed = stages.every((stage) => stage.code === 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(OUT_DIR, `${stamp}-${options.area}.log`);
  const logText = log.join('');
  fs.writeFileSync(logPath, logText, 'utf8');
  const summary = {
    passed, area: options.area, stages, logPath,
    ...(passed ? {} : { failureExcerpt: failureExcerpt(logText) })
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = passed ? 0 : 1;
  return summary;
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { AREA_TESTS, parseArgs, run, failureExcerpt, main };
