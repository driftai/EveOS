#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'Nexus-Browser');
const RESULT_DIR = path.join(ROOT, 'data', 'runtime', 'smoke-results');
const MAX_CAPTURE = 4 * 1024 * 1024;
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
const tests = fs.readdirSync(path.join(TOOL, 'tests')).filter((name) => name.endsWith('.test.js')).sort();
const suites = [
  { id: 'lifecycle', command: process.platform === 'win32' ? 'python.exe' : 'python3', args: ['tools/smoke/nexus_browser_control_smoke.py'], cwd: ROOT },
  { id: 'surface', command: process.execPath, args: ['tools/smoke/nexus_browser_surface_smoke.js'], cwd: ROOT },
  { id: 'machine-spaces-browser', command: process.execPath, args: ['tools/smoke/nexus_machine_spaces_browser_smoke.js'], cwd: ROOT },
  { id: 'upstream-contracts', command: process.execPath, args: ['--test', ...tests.map((name) => path.join('tests', name))], cwd: TOOL }
];

function run(suite) {
  const result = spawnSync(suite.command, suite.args, { cwd: suite.cwd, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_CAPTURE });
  const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
  if (verbose && output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  return { id: suite.id, ok: result.status === 0, status: result.status, output };
}

const results = [];
for (const suite of suites) {
  const result = run(suite);
  results.push(result);
  if (!result.ok) break;
}
const failed = results.filter((result) => !result.ok);
if (failed.length) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  const artifact = path.join(RESULT_DIR, 'nexus-browser-failure.log');
  fs.writeFileSync(artifact, results.map((result) => `===== ${result.id} (${result.status}) =====\n${result.output}`).join('\n\n'), 'utf8');
  console.error(`NEXUS_BROWSER_SMOKE: PASS ${results.length - failed.length} | FAIL ${failed.length}`);
  for (const result of failed) {
    console.error(`[FAIL] ${result.id}`);
    console.error(result.output.split(/\r?\n/).filter(Boolean).slice(-35).join('\n'));
  }
  console.error(`[DIAGNOSTIC] ${path.relative(ROOT, artifact).replace(/\\/g, '/')}`);
  process.exit(1);
}
console.log(`NEXUS_BROWSER_SMOKE: PASS ${results.length} | FAIL 0`);
