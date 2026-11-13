import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
    detectEdgeBeta, edgeBetaCandidates, firstRunSummary, installationArguments,
    EDGE_BETA_PAGE, EDGE_BETA_WINGET_ID
} from '../tools/setup/eveos_first_run_core.mjs';

const env = {
    'PROGRAMFILES(X86)': path.join('C:', 'Program Files (x86)'),
    PROGRAMFILES: path.join('C:', 'Program Files'),
    LOCALAPPDATA: path.join('C:', 'Users', 'ExampleUser', 'AppData', 'Local')
};

test('non-Windows refuses Direct mode without blocking EveOS', () => {
    assert.deepEqual(edgeBetaCandidates(env, 'linux'), []);
    const info = firstRunSummary({ platform: 'linux', edgeBeta: detectEdgeBeta({ env, platform: 'linux' }) });
    assert.equal(info.spotifyDirect, 'windows-only');
    assert.equal(info.baseEveOS, 'independent-of-edge-beta');
});
test('Windows searches only Edge Beta, never Edge Stable or Chromium', () => {
    const paths = edgeBetaCandidates(env, 'win32');
    assert.equal(paths.length, 3);
    for (const p of paths) assert.ok(p.includes(path.join('Microsoft', 'Edge Beta', 'Application', 'msedge.exe')));
    assert.ok(paths.every(p => !p.includes(path.join('Microsoft', 'Edge', 'Application'))));
});
test('Windows without Edge Beta offers only optional installation', () => {
    const edgeBeta = detectEdgeBeta({ env, platform: 'win32', existsSync: () => false });
    const info = firstRunSummary({ platform: 'win32', edgeBeta, wingetAvailable: true });
    assert.equal(info.spotifyDirect, 'needs-edge-beta');
    assert.equal(info.automaticInstallPerformed, false);
    assert.equal(info.wingetAvailable, true);
});
test('existing Edge Beta qualifies without touching the installation', () => {
    const [installed] = edgeBetaCandidates(env, 'win32');
    const edgeBeta = detectEdgeBeta({ env, platform: 'win32', existsSync: p => p === installed });
    const info = firstRunSummary({ platform: 'win32', edgeBeta, wingetAvailable: true });
    assert.equal(info.spotifyDirect, 'available-browser-present');
    assert.equal(info.edgeBetaExecutable, installed);
});
test('installation command uses exact Microsoft package and official WinGet source', () => {
    assert.equal(EDGE_BETA_WINGET_ID, 'Microsoft.Edge.Beta');
    assert.equal(EDGE_BETA_PAGE, 'https://www.microsoft.com/en-us/edge/download/insider');
    assert.deepEqual(installationArguments(), [
        'install', '--id', 'Microsoft.Edge.Beta', '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements'
    ]);
});
test('duplicated root candidates are deduplicated', () => {
    const paths = edgeBetaCandidates({ 'PROGRAMFILES(X86)': 'x', PROGRAMFILES: 'x', LOCALAPPDATA: 'y' }, 'win32');
    assert.equal(paths.length, 2);
});
