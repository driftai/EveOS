#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULT_DIR = path.join(ROOT, 'data', 'runtime', 'smoke-results');
const CACHE_FILE = path.join(RESULT_DIR, 'fast-pass-cache.json');
const MAX_FAILURE_LINES = 38;
const MAX_FAILURE_LINE_CHARS = 700;
const MAX_CAPTURE_CHARS = 3 * 1024 * 1024;
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.py', '.html', '.css', '.json', '.bat', '.ps1', '.md']);
const SKIP_PARTS = ['/node_modules/', '/data/runtime/', '/test-results/', '/.git/', '/js/vendor/', '/public/vendor/'];

const PROFILES = Object.freeze({
  fast: ['smoke:file-size', 'smoke:regressions', 'smoke:watchfusion'],
  deep: [
    'smoke:file-size', 'smoke:regressions', 'smoke:control-plane', 'smoke:world-book',
    'smoke:search-monitor', 'smoke:audioflix-state', 'smoke:audioflix-playback',
    'smoke:audioflix-piano', 'smoke:piano-queue', 'smoke:piano-metadata', 'smoke:watchfusion'
  ],
  security: ['smoke:server-security', 'smoke:watchfusion-security']
});

function argValue(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function gitFiles(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').split(/\r?\n/).filter(Boolean) : [];
}

function trackedInputs() {
  const candidates = new Set([
    ...gitFiles(['ls-files']),
    ...gitFiles(['ls-files', '--others', '--exclude-standard'])
  ]);
  return [...candidates]
    .map((relative) => relative.replace(/\\/g, '/'))
    .filter((relative) => CODE_EXTENSIONS.has(path.extname(relative).toLowerCase()))
    .filter((relative) => !SKIP_PARTS.some((part) => `/${relative}`.includes(part)))
    .sort();
}

function inputFingerprint() {
  const hash = crypto.createHash('sha256');
  hash.update(`${process.platform}:${process.arch}:${process.versions.node}\n`);
  for (const relative of trackedInputs()) {
    const absolute = path.join(ROOT, relative);
    let stat;
    try { stat = fs.statSync(absolute); } catch { continue; }
    if (!stat.isFile()) continue;
    hash.update(`${relative}:${stat.size}\n`);
    hash.update(fs.readFileSync(absolute));
  }
  return hash.digest('hex');
}

function reusableFastPass(fingerprint) {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return cached.status === 'PASS' && cached.profile === 'fast' && cached.inputFingerprint === fingerprint
      ? cached : null;
  } catch {
    return null;
  }
}

function bounded(value, max = MAX_CAPTURE_CHARS) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n[truncated at ${max} characters]` : text;
}

function failureContext(value) {
  const lines = String(value || 'Unknown failure')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const relevant = lines.filter((line) => /error|fail|traceback|assert|expected|received|timeout|not found|exception|at\s+\S+/i.test(line));
  return (relevant.length ? relevant : lines)
    .slice(0, MAX_FAILURE_LINES)
    .map((line) => line.slice(0, MAX_FAILURE_LINE_CHARS))
    .join('\n');
}

function runScript(name, verbose) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', '--silent', name], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_CAPTURE_CHARS
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (verbose && output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  return { name, ok: result.status === 0, status: result.status, output, error: result.error?.message || '' };
}

function writeFailure(profile, results) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  const file = path.join(RESULT_DIR, `${profile}-failure.log`);
  const body = results.map((result) => [
    `===== ${result.name} (status ${result.status}) =====`,
    result.error,
    bounded(result.output)
  ].filter(Boolean).join('\n')).join('\n\n');
  fs.writeFileSync(file, body, 'utf8');
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function saveFastPass(fingerprint, passCount) {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({
    timestamp: new Date().toISOString(),
    status: 'PASS',
    profile: 'fast',
    inputFingerprint: fingerprint,
    pass: passCount,
    fail: 0
  }, null, 2), 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const profile = argValue(args, '--profile', 'fast');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const reuse = args.includes('--reuse-pass');
  const scripts = PROFILES[profile];
  if (!scripts) {
    console.error(`Unknown EveOS smoke profile: ${profile}`);
    process.exit(2);
  }

  const fingerprint = inputFingerprint();
  if (profile === 'fast' && reuse && !verbose) {
    const cached = reusableFastPass(fingerprint);
    if (cached) {
      console.log(`EVEOS SMOKE: REUSED PASS ${cached.pass} | FAIL 0 | PROFILE fast`);
      return;
    }
  }

  const results = [];
  for (const script of scripts) {
    const result = runScript(script, verbose);
    results.push(result);
    if (!result.ok) break;
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    const diagnostic = writeFailure(profile, results);
    console.error(`EVEOS SMOKE: PASS ${results.length - failed.length} | FAIL ${failed.length} | PROFILE ${profile}`);
    for (const result of failed) {
      console.error(`[FAIL] ${result.name}`);
      console.error(failureContext(result.error || result.output));
    }
    console.error(`[DIAGNOSTIC] ${diagnostic}`);
    process.exit(1);
  }

  if (profile === 'fast') saveFastPass(fingerprint, results.length);
  console.log(`EVEOS SMOKE: PASS ${results.length} | FAIL 0 | PROFILE ${profile}`);
}

main();
