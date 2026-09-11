import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFastSmoke } from './node/fast.smoke.js';
import { runNodeSmokes } from './node/server.smoke.js';
import { runPlaybackStateSmokes } from './node/playback-state.smoke.js';
import { runMediaSmokes } from './node/media.smoke.js';
import { runMediaResolverSmokes } from './node/media-resolver.smoke.js';
import { runRealtimeSmokes } from './node/realtime.smoke.js';
import { runNuvioSmokes } from './node/nuvio.smoke.js';
import { runVoxelVisionSmokes } from './node/voxelvision.smoke.js';
import { runUnifiedMediaProviderSmokes } from './node/unified-media-provider.smoke.js';
import { runSecuritySmokes } from './node/security.smoke.js';
import { runSourceTabSmokes } from './node/source-tab-wiring.smoke.js';
import { runMergerIndependenceSmokes } from './node/merger-independence.smoke.js';
import { runLanSmoke } from './integration/lan.smoke.js';
import { runCloudflareSmoke } from './integration/cloudflare.smoke.js';
import { runYouTubeSmoke } from './integration/youtube-live.smoke.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULTS = path.join(ROOT, 'test-results');
const FAST_PASS_CACHE = path.join(RESULTS, 'fast-pass-cache.json');
const MAX_FAILURE_CONTEXT_LINES = 38;
const MAX_FAILURE_LINE_CHARS = 600;
const MAX_DIAGNOSTIC_CHARS = 2 * 1024 * 1024;
const has = (args, ...names) => names.some(name => args.includes(name));
const FINGERPRINT_INPUTS = [
  '.gitignore',
  'AGENTS.md',
  'WatchFusion.bat',
  'package.json',
  'package-lock.json',
  'playwright.config.js',
  'server.js',
  'nuvio/.gitkeep',
  'public',
  'scripts',
  'src',
  'tests',
  'voxelvision'
];
const FINGERPRINT_SKIP_DIRS = new Set(['.runtime', 'imported', 'node_modules', 'test-results', 'tools']);

function hashInput(hash, absolute) {
  if (!fs.existsSync(absolute)) return;
  const stat = fs.lstatSync(absolute);
  const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');
  if (stat.isSymbolicLink()) {
    hash.update(`link:${relative}:${fs.readlinkSync(absolute)}\n`);
    return;
  }
  if (stat.isDirectory()) {
    if (FINGERPRINT_SKIP_DIRS.has(path.basename(absolute))) return;
    for (const name of fs.readdirSync(absolute).sort()) hashInput(hash, path.join(absolute, name));
    return;
  }
  hash.update(`file:${relative}:${stat.size}\n`);
  hash.update(fs.readFileSync(absolute));
}

function inputFingerprint() {
  const hash = crypto.createHash('sha256');
  hash.update(`${process.platform}:${process.arch}:${process.versions.node}\n`);
  for (const relative of FINGERPRINT_INPUTS) hashInput(hash, path.join(ROOT, relative));
  return hash.digest('hex');
}

function reusableFastPass(fingerprint) {
  try {
    const cached = JSON.parse(fs.readFileSync(FAST_PASS_CACHE, 'utf8'));
    if (cached.status !== 'PASS' || cached.profile !== 'fast' || cached.inputFingerprint !== fingerprint) return null;
    if (!Number.isInteger(cached.pass) || cached.fail !== 0 || !Number.isInteger(cached.skip)) return null;
    return cached;
  } catch {
    return null;
  }
}

function boundedText(value, maxChars = MAX_DIAGNOSTIC_CHARS) {
  const text = String(value || '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[diagnostic truncated at ${maxChars} characters]` : text;
}

function failureContext(value) {
  const lines = String(value || 'Unknown error')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
  const relevant = lines.filter(line => /error|fail|timeout|expected|received|assert|at\s+\S+/i.test(line));
  return (relevant.length ? relevant : lines)
    .slice(0, MAX_FAILURE_CONTEXT_LINES)
    .map(line => line.slice(0, MAX_FAILURE_LINE_CHARS))
    .join('\n');
}

function saveBrowserDiagnostics(error) {
  const file = path.join(RESULTS, 'browser-failure.json');
  fs.writeFileSync(file, JSON.stringify({
    timestamp: new Date().toISOString(),
    message: boundedText(error?.message),
    stdout: boundedText(error?.stdout),
    stderr: boundedText(error?.stderr)
  }, null, 2));
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

async function main() {
  const args = process.argv.slice(2);
  const full = has(args, '--full', 'all');
  const deep = full || has(args, '--deep');
  const browser = full || has(args, '--browser');
  const integration = full || has(args, '--integration');
  const node = deep || has(args, '--node');
  const security = full || deep || has(args, '--security');
  const verbose = has(args, '--verbose', '-v');
  const quiet = !verbose;
  const results = [];

  fs.mkdirSync(RESULTS, { recursive: true });

  // Default smoke is deliberately deterministic, local, and small. Agents
  // should use this after ordinary edits. --deep/--full opt into the slower
  // feature matrix, live integrations, and browser suite.
  const fast = !node && !browser && !integration && !has(args, '--security') || has(args, '--fast', '--smoke');
  const profile = browser ? 'browser' : integration ? 'integration' : node ? 'deep-node' : 'fast';
  const fingerprint = inputFingerprint();
  const canReuse = has(args, '--reuse-pass') && fast && !node && !browser && !integration && !security && !verbose;
  const reused = canReuse ? reusableFastPass(fingerprint) : null;
  if (reused) {
    console.log(`WATCHFUSION SMOKE: REUSED PASS ${reused.pass} | FAIL 0 | SKIP ${reused.skip} | TOTAL ${reused.pass + reused.skip}`);
    return;
  }

  results.push(...await runMergerIndependenceSmokes());
  if (fast) results.push(...await runFastSmoke());

  if (node) {
    results.push(...await runNodeSmokes());
    results.push(...await runPlaybackStateSmokes());
    results.push(...await runMediaSmokes());
    results.push(...await runMediaResolverSmokes());
    results.push(...await runRealtimeSmokes());
    results.push(...await runNuvioSmokes());
    results.push(...await runVoxelVisionSmokes());
    results.push(...await runUnifiedMediaProviderSmokes());
    results.push(...await runSourceTabSmokes());
  }

  if (security) results.push(...await runSecuritySmokes());

  if (integration) {
    for (const [id, run] of [['INT-LAN', runLanSmoke], ['INT-CF', runCloudflareSmoke], ['INT-YT', runYouTubeSmoke]]) {
      try { results.push(...await run()); } catch (error) { results.push({ id, status: 'FAIL', error: error.message }); }
    }
  }

  if (browser) {
    try {
      execSync('npx playwright test', { cwd: ROOT, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
      results.push({ id: 'BROWSER:playwright-suite', status: 'PASS' });
    } catch (error) {
      const diagnostic = saveBrowserDiagnostics(error);
      const combined = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
      results.push({
        id: 'BROWSER:playwright-suite',
        status: 'FAIL',
        error: failureContext(combined),
        diagnostic
      });
    }
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  fs.writeFileSync(path.join(RESULTS, 'smoke-summary.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    status: fail ? 'FAIL' : 'PASS',
    profile,
    inputFingerprint: fingerprint,
    pass, fail, skip, results
  }, null, 2));
  if (!fail && profile === 'fast') {
    fs.writeFileSync(FAST_PASS_CACHE, JSON.stringify({
      timestamp: new Date().toISOString(),
      status: 'PASS',
      profile,
      inputFingerprint: fingerprint,
      pass, fail, skip
    }, null, 2));
  }

  if (fail) {
    console.error(`WATCHFUSION SMOKE: PASS ${pass} | FAIL ${fail} | SKIP ${skip} | TOTAL ${results.length}`);
    const seen = new Set();
    for (const r of results.filter(r => r.status === 'FAIL')) {
      const key = `${r.id}:${r.error || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.error(`[FAIL] ${r.id}: ${failureContext(r.error)}`);
      if (r.diagnostic) console.error(`[DIAGNOSTIC] ${r.diagnostic}`);
    }
    process.exit(1);
  }
  console.log(`WATCHFUSION SMOKE: PASS ${pass} | FAIL ${fail} | SKIP ${skip} | TOTAL ${results.length}`);
}

main().catch(error => {
  console.error(`WATCHFUSION SMOKE: CRASH\n${failureContext(error?.stack || error?.message)}`);
  process.exit(1);
});
