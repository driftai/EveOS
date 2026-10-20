'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Fixed browser scenario registry. Never turn prompt text into shell/JS commands.
const SCENARIOS = Object.freeze({
  'agent-nexus-browser': Object.freeze({
    runner: 'tools/smoke/agent_nexus_browser_smoke.js',
    command: 'node tools/smoke/agent_nexus_browser_smoke.js'
  })
});
const PREPARE_FIELDS = new Set(['action', 'scenario', 'space', 'terminal', 'terminalId']);
const ALLOWED_TARGET_TYPES = new Set(['cmd', 'powershell', 'pwsh']);
function deny(code, message) { return Object.assign(new Error(message), { code }); }
function canonical(value) {
  try { return fs.realpathSync.native(String(value || '')); }
  catch { throw deny('MACHINE_PLAYWRIGHT_ROOT_UNAVAILABLE', 'The assigned repository root or terminal cwd is unavailable.'); }
}
function sameLocation(a, b) {
  const left = canonical(a), right = canonical(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function registeredPlan({ command, target, repoRoot } = {}) {
  if (!command || typeof command !== 'object' || Array.isArray(command))
    throw deny('MACHINE_PLAYWRIGHT_BAD_REQUEST', 'Playwright preparation requires one exact registered scenario.');
  for (const key of Object.keys(command)) if (!PREPARE_FIELDS.has(key))
    throw deny('MACHINE_PLAYWRIGHT_BAD_FIELD', `Playwright preparation cannot accept ${key}; only registered scenarios are allowed.`);
  const scenario = command.scenario;
  if (typeof scenario !== 'string' || !Object.hasOwn(SCENARIOS, scenario))
    throw deny('MACHINE_PLAYWRIGHT_UNKNOWN_SCENARIO', 'Choose an exact registered Playwright scenario.');
  if (!target || !ALLOWED_TARGET_TYPES.has(target.type))
    throw deny('MACHINE_PLAYWRIGHT_BAD_TARGET', 'Playwright requires an attached Windows CMD or PowerShell target.');
  if (!sameLocation(target.cwd, repoRoot))
    throw deny('MACHINE_PLAYWRIGHT_ROOT_MISMATCH', 'The managed target must use the exact EveOS repository root.');
  const selected = SCENARIOS[scenario];
  const runner = path.join(canonical(repoRoot), ...selected.runner.split('/'));
  if (!fs.statSync(runner).isFile())
    throw deny('MACHINE_PLAYWRIGHT_RUNNER_MISSING', 'Registered Playwright runner is not a file.');
  const runnerSha256 = createHash('sha256').update(fs.readFileSync(runner)).digest('hex');
  return { kind: 'playwright-acceptance', scenario, command: selected.command, runnerSha256 };
}
function verifyPrepared({ stored, target, repoRoot } = {}) {
  if (!stored || stored.kind !== 'playwright-acceptance')
    throw deny('MACHINE_PLAYWRIGHT_PLAN_UNAVAILABLE', 'The queued Playwright plan is missing.');
  const rebuilt = registeredPlan({ command: { action: 'playwright_prepare', scenario: stored.scenario }, target, repoRoot });
  if (stored.command !== rebuilt.command || stored.runnerSha256 !== rebuilt.runnerSha256)
    throw deny('MACHINE_PLAYWRIGHT_PLAN_CHANGED', 'The registered runner changed since preparation. Prepare a new supervised job.');
  return rebuilt;
}
module.exports = { SCENARIOS, PREPARE_FIELDS, registeredPlan, verifyPrepared };
