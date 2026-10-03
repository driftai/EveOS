#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const runtime = path.join(ROOT, 'tools', 'runtime', 'nexus-browser-runtime.mjs');
const source = fs.readFileSync(runtime, 'utf8');
const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};

function requireCondition(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

requireCondition(source.includes("configureHeadedServices(['nexusBrowser'])"),
  'isolated runtime does not scope headed configuration to Nexus Browser');
for (const forbidden of ['ensureLocalModelRuntime', 'waitForTloReady', "startService('localMoe')", "startService('web')", "startService('gemini')"]) {
  requireCondition(!source.includes(forbidden), `isolated Nexus runtime contains unrelated startup path: ${forbidden}`);
}
for (const action of ['start', 'status', 'stop', 'restart']) {
  const script = scripts[`runtime:nexus-browser:${action}`];
  requireCondition(typeof script === 'string' && script.includes('nexus-browser-runtime.mjs'),
    `runtime:nexus-browser:${action} is missing or not isolated`);
}

const plan = spawnSync(process.execPath, [runtime, 'plan'], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10_000
});
const output = [plan.stdout, plan.stderr].filter(Boolean).join('\n');
requireCondition(plan.status === 0, `isolated runtime plan failed: ${output || plan.error?.message || 'unknown error'}`);
requireCondition(output.includes('SERVICES nexusBrowser'), 'isolated plan does not select Nexus Browser');
requireCondition(output.includes('local-moe=untouched'), 'isolated plan does not state Local MoE isolation');

console.log('NEXUS_BROWSER_RUNTIME_ISOLATION_SMOKE_OK');
