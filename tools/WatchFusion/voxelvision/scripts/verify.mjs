import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const syntaxOnly = process.argv.includes('--syntax-only');
const startedAt = Date.now();
const maxFailureLines = 24;

function projectScripts() {
  const files = ['server.js', 'youtube-import.js', 'media-range.js'];
  for (const name of fs.readdirSync(path.join(root, 'public', 'js'))) {
    if (name.endsWith('.js')) files.push(path.join('public', 'js', name));
  }
  for (const name of fs.readdirSync(path.join(root, 'scripts'))) {
    if (name.endsWith('.mjs') || name.endsWith('.cjs')) files.push(path.join('scripts', name));
  }
  return files.sort();
}

const checks = projectScripts().map(file => ({
  id: `syntax:${file.replaceAll('\\', '/')}`,
  command: process.execPath,
  args: ['--check', file]
}));

if (!syntaxOnly) {
  checks.push(
    { id: 'smoke:foreground-mask-assist', command: process.execPath, args: ['scripts/foreground-mask-assist-smoke.mjs'] },
    { id: 'smoke:media-range', command: process.execPath, args: ['scripts/media-range-smoke.mjs'] },
    { id: 'smoke:temporal-sampling', command: process.execPath, args: ['scripts/temporal-sampling-smoke.mjs'] },
    { id: 'smoke:youtube-quality', command: process.execPath, args: ['scripts/youtube-quality-smoke.mjs'] },
    { id: 'smoke:capabilities', command: process.execPath, args: ['scripts/capability-profile-smoke.mjs'] },
    { id: 'smoke:live-depth', command: process.execPath, args: ['scripts/live-depth-stability-smoke.mjs'] },
    { id: 'smoke:depth-models', command: process.execPath, args: ['scripts/depth-model-profiles-smoke.mjs'] },
    { id: 'smoke:adaptive-fps', command: process.execPath, args: ['scripts/adaptive-fps-governor-smoke.mjs'] },
    { id: 'smoke:adaptive-quality', command: process.execPath, args: ['scripts/adaptive-quality-governor-smoke.mjs'] },
    { id: 'smoke:depth-cache', command: process.execPath, args: ['scripts/depth-cache-smoke.mjs'] },
    { id: 'smoke:depth-cache-reuse', command: process.execPath, args: ['scripts/depth-cache-reuse-smoke.mjs'] },
    { id: 'smoke:depth-profile-resume', command: process.execPath, args: ['scripts/depth-profile-resume-smoke.mjs'] },
    { id: 'smoke:depth-fusion-score', command: process.execPath, args: ['scripts/depth-fusion-score-smoke.mjs'] },
    { id: 'smoke:foreground-detail', command: process.execPath, args: ['scripts/foreground-detail-recovery-smoke.mjs'] },
    { id: 'smoke:depth-feedback-report', command: process.execPath, args: ['scripts/depth-feedback-report-smoke.mjs'] },
    { id: 'smoke:public-release', command: process.execPath, args: ['scripts/public-release-smoke.mjs'] }
  );
}

const results = [];
for (const check of checks) {
  const began = Date.now();
  const result = spawnSync(check.command, check.args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const record = {
    id: check.id,
    passed: result.status === 0 && !result.error,
    exitCode: result.status,
    durationMs: Date.now() - began,
    output
  };
  results.push(record);
  if (verbose) console.log(`${record.passed ? 'PASS' : 'FAIL'} ${record.id} (${record.durationMs} ms)${output ? `\n${output}` : ''}`);
}

const failed = results.filter(result => !result.passed);
const artifact = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  passed: results.length - failed.length,
  failed: failed.length,
  results
};
const artifactDir = path.resolve(root, 'test-results');
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, 'voxelvision-verify.json'), `${JSON.stringify(artifact, null, 2)}\n`);

const label = syntaxOnly ? 'CHECK' : 'VERIFY';
console.log(`VOXELVISION ${label}: ${failed.length ? 'FAIL' : 'PASS'} · ${artifact.passed}/${results.length} passed · ${artifact.durationMs} ms`);
if (failed.length) {
  for (const failure of failed) {
    console.error(`\n[${failure.id}] exit ${failure.exitCode ?? 'spawn error'}`);
    const lines = String(failure.output || 'No diagnostic output.').split(/\r?\n/);
    console.error(lines.slice(-maxFailureLines).join('\n'));
    if (lines.length > maxFailureLines) console.error(`… ${lines.length - maxFailureLines} earlier lines saved in test-results/voxelvision-verify.json`);
  }
  process.exitCode = 1;
}
