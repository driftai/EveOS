#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const terminal = require('./machine-spaces-terminal-qualify');

const CONTROL_TESTS = Object.freeze([
  'tests/provider-content-rehydration.test.js',
  'tests/dex-origin-finalization.test.js',
  'tests/provider-control-origin-race.test.js',
  'tests/dex-provider-control-dedup.test.js',
  'tests/dex-managed-worker-provider-control.test.js',
  'tests/provider-target-spawn-routing.test.js',
  'tests/machine-spaces-agent-quorum.test.js',
  'tests/machine-spaces-agent-quorum-provider-control.test.js',
  'tests/machine-spaces-external-terminal-process-adapter.test.js',
  'tests/machine-spaces-trusted-attach-controller.test.js',
  'tests/machine-spaces-trusted-terminal-attachment.test.js'
]);

function runControlTests() {
  const result = spawnSync(process.execPath, ['--test', ...CONTROL_TESTS], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024
  });
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    exitCode: result.status,
    tests: [...CONTROL_TESTS],
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

function runExternalAdapterLive(enabled) {
  if (!enabled) return { status: 'SKIP', reason: 'Use --external-live to exercise trusted external PID observe/interrupt through the running Nexus server.' };
  const script = path.join(__dirname, 'external-terminal-adapter-qualify.js');
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024
  });
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    exitCode: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const options = terminal.parseArgs(argv);
  const deterministicControl = runControlTests();
  const machine = await terminal.runQualificationReport(options);
  const externalAdapter = runExternalAdapterLive(argv.includes('--external-live'));
  const sections = [deterministicControl, machine, externalAdapter].filter((entry) => entry.status !== 'SKIP');
  const status = sections.some((entry) => entry.status === 'FAIL')
    ? 'FAIL'
    : sections.some((entry) => entry.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  const report = {
    kind: 'machine-spaces-all-qualification',
    at: new Date().toISOString(),
    status,
    deterministicControl,
    machine,
    externalAdapter,
    liveStillRequired: {
      exactOriginFinalization: 'REAL_COMMITTED_PROVIDER_REPLY',
      managedEveSpawn: 'REAL_COMMITTED_CHATGPT_REPLY',
      realAgentQuorum: 'REAL_COMMITTED_CHATGPT_AND_HARK_REPLIES'
    }
  };
  process.stdout.write('MACHINE_SPACES_ALL_QUALIFICATION_BEGIN\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('MACHINE_SPACES_ALL_QUALIFICATION_END\n');
  process.exitCode = status === 'PASS' ? 0 : status === 'BLOCKED' ? 2 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write('MACHINE_SPACES_ALL_QUALIFICATION_BEGIN\n');
    process.stdout.write(JSON.stringify({ status: 'FAIL', code: error.code || error.name, reason: error.message }, null, 2) + '\n');
    process.stdout.write('MACHINE_SPACES_ALL_QUALIFICATION_END\n');
    process.exitCode = 1;
  });
}

module.exports = { CONTROL_TESTS, runControlTests, runExternalAdapterLive, main };