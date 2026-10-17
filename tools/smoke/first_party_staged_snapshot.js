'use strict';
const { spawnSync } = require('node:child_process');

function git(root, args) {
    const result = spawnSync('git', args, {
        cwd: root, encoding: 'utf8', windowsHide: true,
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Git snapshot read failed (${args[0]}): ${
            String(result.stderr || result.error || 'unknown failure').trim()}`);
    }
    return result.stdout;
}

function physicalLines(source) {
    if (!source) return 0;
    return source.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function stagedFiles(root, accepts = () => true) {
    const names = git(root, [
        'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'
    ]).split('\0').filter(Boolean).filter(accepts);
    return names.map((name) => {
        const indexEntries = git(root, ['ls-files', '--stage', '-z', '--', name])
            .split('\0').filter(Boolean);
        const entry = indexEntries.find((line) => {
            const tab = line.indexOf('\t');
            return tab !== -1 && line.slice(tab + 1) === name
                && /^(100644|100755) [a-f0-9]+ 0$/.test(line.slice(0, tab));
        });
        if (!entry) {
            throw new Error(`Staged source has no ordinary stage-zero Git blob: ${name}`);
        }
        const oid = entry.slice(7).split(' ')[0];
        return { relative: name, source: git(root, ['cat-file', 'blob', oid]) };
    });
}

module.exports = { stagedFiles, physicalLines };