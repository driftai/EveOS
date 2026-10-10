import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceScript = path.resolve('tools/setup/eveos_local_hygiene.mjs');

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
    }
    return result;
}

function write(root, relative, content) {
    const full = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return full;
}

function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-hygiene-test-'));
    const script = path.join(root, 'tools', 'setup', 'eveos_local_hygiene.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(sourceScript, script);
    run('git', ['init'], root);
    run('git', ['config', 'user.email', 'test@example.invalid'], root);
    run('git', ['config', 'user.name', 'EveOS Hygiene Test'], root);
    return { root, script };
}

function trackCanonical(root, relative, content) {
    write(root, relative, content);
    run('git', ['add', '--', relative], root);
}

{
    const { root, script } = makeRepo();
    try {
        const legacy = 'data/runtime/smoke-results/lane3-runtime-acceptance.mjs';
        const canonical = 'tools/qualification/audioflix_lane3_runtime_acceptance.mjs';
        trackCanonical(root, canonical, 'same bytes\n');
        write(root, legacy, 'same bytes\n');
        const result = run(process.execPath, [script, '--prune-promoted'], root);
        assert.equal(fs.existsSync(path.join(root, legacy)), false, 'identical legacy driver should be pruned');
        assert.match(result.stdout, /PRUNED byte-identical promoted legacy driver/);
        assert.equal(fs.existsSync(path.join(root, 'data/runtime/hygiene-backups')), false,
            'identical legacy driver should not create a needless backup');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

{
    const { root, script } = makeRepo();
    try {
        const legacy = 'data/runtime/smoke-results/lane3-runtime-acceptance.mjs';
        const canonical = 'tools/qualification/audioflix_lane3_runtime_acceptance.mjs';
        trackCanonical(root, canonical, 'canonical version\n');
        write(root, legacy, 'unique local edit\n');
        const result = run(process.execPath, [script, '--prune-promoted'], root);
        assert.equal(fs.existsSync(path.join(root, legacy)), false, 'differing legacy driver should be pruned only after backup');
        assert.match(result.stdout, /PRUNED promoted legacy driver with verified backup/);
        const match = result.stdout.match(/^BACKUP .* -> (data\/runtime\/hygiene-backups\/promoted\/[^\r\n]+)$/m);
        assert.ok(match, `backup location must be reported; got ${result.stdout}`);
        const backup = path.join(root, ...match[1].split('/'));
        assert.equal(fs.readFileSync(backup, 'utf8'), 'unique local edit\n',
            'backup must preserve the exact unique local content');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

{
    const { root, script } = makeRepo();
    try {
        write(root, 'data/runtime/smoke-results/extension-browser/official-abc/package/modules/generated.js', 'generated\n');
        write(root, 'data/runtime/smoke-results/extension-browser/official-abc/package/popup.js', 'generated\n');
        write(root, 'data/runtime/smoke-results/restart-managed-spotify-helper.ps1', 'unique helper\n');
        const result = run(process.execPath, [script], root);
        const combined = `${result.stdout}\n${result.stderr}`;
        assert.match(combined, /EVEOS_LOCAL_HYGIENE_GENERATED_EXTENSION_PACKAGES packages=1 sourceFiles=2/,
            'generated extension package files should be grouped into one informational summary');
        assert.doesNotMatch(combined, /package\/modules\/generated\.js looks like reusable source/,
            'generated package mirror files must not create misleading reusable-source warnings');
        assert.match(combined, /restart-managed-spotify-helper\.ps1 looks like reusable source/,
            'genuine stranded source must still be reported');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

console.log('EVEOS_LOCAL_HYGIENE_CONTRACT_OK backupVerified=true generatedPackagesGrouped=true strandedSourceRetained=true');
