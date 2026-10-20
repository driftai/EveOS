#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS = path.join(ROOT, 'data', 'runtime', 'smoke-results');
const PROTECTED = ['docs/EVEOS-V0.7.5-DE-MIDDLEMAN-LEDGER.md', 'docs/NEXUS-PHASE3-AUTONOMOUS-RECOVERY.md'];
const focused = ['npm run --silent test:guardrails', 'npm run --silent smoke:agent-management',
    'npm run --silent smoke:agent-nexus-browser', 'npm run --silent smoke:agent-nexus'];
const profiles = {
    focused,
    'ai-control': [...focused, 'npm run --silent test:ai-control'],
    release: [...focused, 'npm run --silent test:ai-control',
        'python -B tools/qualification/eveos_timed_qualification.py --profile release --jobs 4']
};

function exec(command, options = {}) {
    return spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'sh',
        process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
}
function text(command) {
    const result = exec(command);
    if (result.status !== 0) throw new Error(`Command failed: ${command}\n${result.stderr || result.stdout}`);
    return String(result.stdout || '').trim();
}
function digest(relative) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, relative))).digest('hex');
}
function parse(argv) {
    const options = { profile: 'focused', expectedHead: '', allowDirty: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--profile' && profiles[argv[i + 1]]) options.profile = argv[++i];
        else if (argv[i] === '--expected-head') options.expectedHead = String(argv[++i] || '');
        else if (argv[i] === '--allow-dirty') options.allowDirty = true;
        else throw new Error(`Unsupported option ${argv[i]}`);
    }
    return options;
}

const options = parse(process.argv.slice(2));
const head = text('git rev-parse HEAD');
if (options.expectedHead && head !== options.expectedHead) throw new Error(`HEAD ${head} != expected ${options.expectedHead}`);
const dirty = text('git status --porcelain --untracked-files=no');
if (dirty && !options.allowDirty) throw new Error('Tracked working tree is dirty; commit the candidate before acceptance.');
const protectedBefore = Object.fromEntries(PROTECTED.map((file) => [file, digest(file)]));
const startedAt = new Date().toISOString(), results = [];
fs.mkdirSync(RESULTS, { recursive: true });
for (const command of profiles[options.profile]) {
    const start = Date.now(), result = exec(command);
    results.push({ command, ok: result.status === 0, exitCode: result.status, elapsedMs: Date.now() - start,
        stdout: String(result.stdout || '').slice(-200000), stderr: String(result.stderr || '').slice(-100000) });
    if (result.status !== 0) break;
}
const protectedAfter = Object.fromEntries(PROTECTED.map((file) => [file, digest(file)]));
const protectedIntact = PROTECTED.every((file) => protectedBefore[file] === protectedAfter[file]);
const ok = results.length === profiles[options.profile].length && results.every((row) => row.ok) && protectedIntact;
const artifact = path.join(RESULTS, `agent-nexus-acceptance-${options.profile}.json`);
fs.writeFileSync(artifact, JSON.stringify({ schema: 'eveos.agent-nexus.acceptance.v1', startedAt,
    finishedAt: new Date().toISOString(), head, profile: options.profile, protectedIntact, results }, null, 2) + '\n');
if (!ok) {
    const failed = results.find((row) => !row.ok);
    console.error(`AGENT_NEXUS_ACCEPTANCE_FAIL profile=${options.profile} command=${failed?.command || 'protected-files'} artifact=${path.relative(ROOT, artifact).replaceAll('\\', '/')}`);
    const lines = `${failed?.stderr || ''}\n${failed?.stdout || ''}`.trim().split(/\r?\n/).slice(-38);
    if (lines.length) console.error(lines.join('\n'));
    process.exit(1);
}
console.log(`AGENT_NEXUS_ACCEPTANCE_OK profile=${options.profile} gates=${results.length} head=${head.slice(0, 12)} artifact=${path.relative(ROOT, artifact).replaceAll('\\', '/')}`);
