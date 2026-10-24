#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runtimeConfig = require('../runtime-config');

const TESTS = Object.freeze([
  'tests/tlo-backend-chat.test.js',
  'tests/tlo-backend-ownership-seam.test.js',
  'tests/tlo-backend-runtime.test.js',
  'tests/tlo-backend-transport.test.js',
  'tests/tlo-conversation-store.test.js',
  'tests/tlo-deployment-coordinator.test.js',
  'tests/tlo-dex-ledger-gate.test.js',
  'tests/tlo-dex-state-authority.test.js',
  'tests/tlo-dispatch-capability.test.js',
  'tests/tlo-inactive-integration.test.js',
  'tests/tlo-ownership-durable-store.test.js',
  'tests/tlo-ownership-fence.test.js',
  'tests/tlo-production-assembly.test.js',
  'tests/tlo-runner-client.test.js',
  'tests/tlo-runner-gate.test.js',
]);
function selectedLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const failures = lines.filter((line) => /^(?:not ok|✖|# Subtest:)/.test(line.trim()));
  const context = lines.filter(Boolean).slice(-32);
  return [...new Set([...failures, ...context])].slice(0, 40);
}
function run(argv = process.argv.slice(2)) {
  const verbose = argv.includes('--verbose');
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--test', ...TESTS], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true,
    timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = String(result.stdout || ''), stderr = String(result.stderr || '');
  const total = Number(stdout.match(/(?:^|\n)[ℹ#]\s*tests\s+(\d+)/)?.[1] || 0);
  const passed = Number(stdout.match(/(?:^|\n)[ℹ#]\s*pass\s+(\d+)/)?.[1] || 0);
  const report = { schema: 'eveos.tlo-deployment-qualification.v1', at: new Date().toISOString(),
    status: result.status === 0 ? 'PASS' : 'FAIL', exitCode: result.status ?? 1,
    elapsedMs: Date.now() - started, tests: TESTS, total, passed, stdout, stderr,
    error: result.error ? String(result.error.stack || result.error.message || result.error) : null };
  const folder = path.join(runtimeConfig.EVEOS_ROOT, 'data', 'runtime', 'smoke-results', 'tlo-deployment');
  fs.mkdirSync(folder, { recursive: true });
  const artifact = path.join(folder, 'latest.json');
  fs.writeFileSync(artifact, JSON.stringify(report, null, 2), 'utf8');
  if (verbose) process.stdout.write(stdout + stderr);
  if (result.status === 0) {
    console.log(`TLO_DEPLOYMENT_QUALIFICATION_OK passed=${passed}/${total} artifact=${path.relative(runtimeConfig.EVEOS_ROOT, artifact)}`);
  } else {
    console.error(`TLO_DEPLOYMENT_QUALIFICATION_FAILED passed=${passed}/${total} artifact=${path.relative(runtimeConfig.EVEOS_ROOT, artifact)}`);
    for (const line of selectedLines(stdout + '\n' + stderr)) console.error(line);
  }
  return result.status === 0 ? 0 : 1;
}
if (require.main === module) process.exitCode = run();
module.exports = { TESTS, selectedLines, run };
