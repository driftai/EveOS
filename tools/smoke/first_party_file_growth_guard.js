const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SOFT_MAX_LINES = 440;
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.py', '.css', '.html', '.bat', '.ps1']);

function git(args) {
    const result = spawnSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
    });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function lines(source) {
    const text = String(source || '');
    if (!text) return 0;
    return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function currentLines(relative) {
    try {
        return lines(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
    } catch {
        return 0;
    }
}

function baseLines(base, relative) {
    if (!base) return 0;
    const result = spawnSync('git', ['show', `${base}:${relative.replace(/\\/g, '/')}`], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
    });
    return result.status === 0 ? lines(result.stdout) : 0;
}

// The staged snapshot is distinct from the working tree during partial staging.
if (process.argv.includes('--staged')) {
    const { stagedFiles, physicalLines } = require('./first_party_staged_snapshot.js');
    const requestedBase = String(process.env.EVEOS_GUARDRAIL_BASE || 'origin/main').trim();
    const mergeBase = git(['merge-base', requestedBase, 'HEAD']);
    if (!mergeBase) throw new Error('Cannot resolve staged growth baseline: ' + requestedBase);
    const entries = stagedFiles(ROOT,
        (relative) => CODE_EXTENSIONS.has(path.extname(relative).toLowerCase()))
        .map(({ relative, source }) => ({
            relative,
            before: baseLines(mergeBase, relative),
            after: physicalLines(source)
        }));
    const violations = entries.filter((entry) =>
        entry.after > SOFT_MAX_LINES && entry.after > entry.before);
    if (violations.length) {
        throw new Error('Staged first-party growth exceeds 440 lines:\n'
            + violations.map(({ relative, before, after }) =>
                `${relative}: ${before} -> ${after} lines`).join('\n'));
    }
    console.log('FIRST_PARTY_STAGED_GROWTH_OK', JSON.stringify({
        base: mergeBase, checked: entries.length
    }));
    process.exit(0);
}
const requestedBase = String(process.env.EVEOS_GUARDRAIL_BASE || 'origin/main').trim();
const mergeBase = git(['merge-base', requestedBase, 'HEAD']);
const changed = new Set();

if (mergeBase) {
    git(['diff', '--name-only', `${mergeBase}..HEAD`])
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((file) => changed.add(file));
}
for (const args of [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['ls-files', '--others', '--exclude-standard']
]) {
    git(args).split(/\r?\n/).filter(Boolean).forEach((file) => changed.add(file));
}

const measured = [...changed]
    .map((relative) => relative.replace(/\\/g, '/'))
    .filter((relative) => CODE_EXTENSIONS.has(path.extname(relative).toLowerCase()))
    .filter((relative) => fs.existsSync(path.join(ROOT, relative)))
    .map((relative) => ({
        relative,
        before: baseLines(mergeBase, relative),
        after: currentLines(relative)
    }))
    .sort((left, right) => right.after - left.after);

const violations = measured.filter((entry) =>
    entry.after > SOFT_MAX_LINES && entry.after > entry.before
);

if (violations.length) {
    const details = violations
        .map((entry) => `${entry.relative}: ${entry.before} -> ${entry.after} lines`)
        .join('\n');
    throw new Error(
        `Changed first-party files grew past the ${SOFT_MAX_LINES}-line headroom guard:\n${details}\n`
        + 'Split the changed responsibility before it reaches the 450-line hard cap.'
    );
}

console.log('FIRST_PARTY_FILE_GROWTH_GUARD_OK', JSON.stringify({
    base: mergeBase || null,
    softMaxLines: SOFT_MAX_LINES,
    changedCodeFiles: measured.length,
    largestChanged: measured[0] || null
}));
