import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'test-results');
const MAX_LINES = 450;
const MAX_FAILURE_LINES = 40;
const quiet = process.argv.includes('--quiet') || process.argv.includes('-q');
const violations = [];

function addViolation(id, detail) {
  violations.push({ id, detail });
}

function scanDir(dir) {
  const files = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === 'original' || item.name === '.git' || item.name === 'test-results') continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      files.push(...scanDir(full));
    } else if (item.name.endsWith('.js') || item.name.endsWith('.mjs')) {
      files.push(full);
    }
  }
  return files;
}

const targetDirs = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'public', 'client'),
  path.join(ROOT, 'scripts')
];

for (const dir of targetDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const file of scanDir(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').length;
    if (lines > MAX_LINES) {
      addViolation('MODULE-SIZE', `${path.relative(ROOT, file)} has ${lines} lines (max ${MAX_LINES})`);
    }
  }
}

const serverLines = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\n').length;
if (serverLines > MAX_LINES) {
  addViolation('MODULE-SIZE', `server.js has ${serverLines} lines (max ${MAX_LINES})`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const quietScripts = ['test', 'test:smoke', 'test:deep', 'test:browser', 'test:integration', 'test:security'];
for (const name of quietScripts) {
  const command = String(packageJson.scripts?.[name] || '');
  if (!command.includes('CHECK-ARCHITECTURE.mjs --quiet') || !command.includes('--quiet')) {
    addViolation('SMOKE-QUIET-COMMAND', `${name} must run guardrails and smoke verification in quiet mode`);
  }
}
if (!String(packageJson.scripts?.['test:smoke'] || '').includes('--reuse-pass')) {
  addViolation('SMOKE-REUSE-COMMAND', 'test:smoke must reuse only fingerprint-matched deterministic passes');
}

const runnerSource = fs.readFileSync(path.join(ROOT, 'tests', 'smoke', 'run.js'), 'utf8');
if (!runnerSource.includes('const quiet = !verbose;')) {
  addViolation('SMOKE-QUIET-DEFAULT', 'tests/smoke/run.js must remain quiet unless --verbose is explicit');
}
if (!runnerSource.includes('MAX_FAILURE_CONTEXT_LINES = 38')) {
  addViolation('SMOKE-FAILURE-BOUND', 'tests/smoke/run.js must bound direct failure context below 40 lines');
}
if (!runnerSource.includes("has(args, '--reuse-pass')") || !runnerSource.includes('inputFingerprint') || !runnerSource.includes('fast-pass-cache.json')) {
  addViolation('SMOKE-REUSE-SAFETY', 'fast pass reuse must remain explicit and content-fingerprint gated');
}

const projectRules = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
if (!projectRules.includes('Do not rerun an unchanged passing suite')) {
  addViolation('SMOKE-NO-REPEAT-RULE', 'AGENTS.md must prohibit redundant reruns of unchanged passing suites');
}
const ignoreRules = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
if (!/^test-results\/$/m.test(ignoreRules)) {
  addViolation('SMOKE-DIAGNOSTIC-IGNORE', 'test-results/ must remain ignored');
}

fs.mkdirSync(RESULTS, { recursive: true });
fs.writeFileSync(path.join(RESULTS, 'guardrail-summary.json'), JSON.stringify({
  timestamp: new Date().toISOString(),
  status: violations.length ? 'FAIL' : 'PASS',
  maxModuleLines: MAX_LINES,
  violations
}, null, 2));

if (violations.length === 0) {
  if (!quiet) console.log(`WATCHFUSION GUARDRAILS: PASS | source max ${MAX_LINES} | smoke output policy enforced`);
  process.exit(0);
}

console.error(`WATCHFUSION GUARDRAILS: FAIL | ${violations.length} violation(s) | diagnostics: test-results/guardrail-summary.json`);
for (const violation of violations.slice(0, MAX_FAILURE_LINES - 1)) {
  console.error(`[${violation.id}] ${violation.detail}`);
}
process.exit(1);
