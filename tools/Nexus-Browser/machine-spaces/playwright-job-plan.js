'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SCENARIOS, publicScenarios } = require('./playwright-scenario-registry');

// Prepare and execute are deliberately separate: this module never launches Chromium.
const PREPARE_FIELDS = new Set(['action', 'scenario', 'space', 'terminal', 'terminalId']);
const ALLOWED_TARGET_TYPES = new Set(['cmd', 'powershell', 'pwsh']);
const SHA256 = /^[a-f0-9]{64}$/;
function deny(code, message) { return Object.assign(new Error(message), { code }); }
function canonical(value) {
  try { return fs.realpathSync.native(String(value || '')); }
  catch { throw deny('MACHINE_PLAYWRIGHT_ROOT_UNAVAILABLE', 'The assigned repository root or terminal cwd is unavailable.'); }
}
function sameLocation(a, b) {
  const left = canonical(a), right = canonical(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function pinSource(root, relative) {
  const absolute = path.join(root, ...relative.split('/'));
  let resolved;
  try { resolved = canonical(absolute); }
  catch { throw deny('MACHINE_PLAYWRIGHT_RUNNER_MISSING', 'A registered browser qualification source is unavailable.'); }
  if (!inside(root, resolved))
    throw deny('MACHINE_PLAYWRIGHT_SOURCE_ESCAPE', 'A registered browser qualification source escapes its repository root.');
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch { throw deny('MACHINE_PLAYWRIGHT_RUNNER_MISSING', 'A registered browser qualification source is unavailable.'); }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw deny('MACHINE_PLAYWRIGHT_SOURCE_UNSAFE', 'A registered browser qualification source must be an ordinary file.');
  return createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
}
function sourceFingerprint(root, scenario) {
  // Hash each named source and its identity, never path-only metadata or mtimes.
  // This is a bounded critical-source pin, not a substitute for repository qualification.
  const sources = [scenario.runner, ...scenario.dependencies];
  const digests = sources.map((relative) => [relative, pinSource(root, relative)]);
  return {
    runnerSha256: digests[0][1],
    evidenceSha256: createHash('sha256').update(JSON.stringify(digests)).digest('hex')
  };
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
  const selected = SCENARIOS[scenario], root = canonical(repoRoot);
  const pins = sourceFingerprint(root, selected);
  return { kind: 'playwright-acceptance', scenario, command: selected.command,
    mode: selected.mode, surface: selected.surface, ...pins };
}
function verifyPrepared({ stored, target, repoRoot } = {}) {
  if (!stored || stored.kind !== 'playwright-acceptance')
    throw deny('MACHINE_PLAYWRIGHT_PLAN_UNAVAILABLE', 'The queued Playwright plan is missing.');
  const rebuilt = registeredPlan({ command: { action: 'playwright_prepare', scenario: stored.scenario }, target, repoRoot });
  if (stored.command !== rebuilt.command || stored.runnerSha256 !== rebuilt.runnerSha256)
    throw deny('MACHINE_PLAYWRIGHT_PLAN_CHANGED', 'The registered runner changed since preparation. Prepare a new supervised job.');
  // Backwards compatibility for already-queued v0 plans with only the runner hash.
  // All newly created jobs carry both hashes and reject dependency changes.
  if (stored.evidenceSha256 !== undefined &&
      (!SHA256.test(stored.evidenceSha256) || stored.evidenceSha256 !== rebuilt.evidenceSha256))
    throw deny('MACHINE_PLAYWRIGHT_PLAN_CHANGED', 'Registered browser qualification dependencies changed. Prepare a new job.');
  if (stored.mode !== undefined && stored.mode !== 'qualification')
    throw deny('MACHINE_PLAYWRIGHT_PLAN_CHANGED', 'The queued browser mode changed. Prepare a new job.');
  return rebuilt;
}
module.exports = { SCENARIOS, PREPARE_FIELDS, publicScenarios, registeredPlan, verifyPrepared };
