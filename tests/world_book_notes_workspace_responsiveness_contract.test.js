'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const client = read('js/modules/features/world-book/world-book.notes.client.js');
const workspace = read('js/modules/features/world-book/world-book.notes.workspace.js');
const css = read('js/modules/features/world-book/world-book.notes.workspace.css');

test('Notes API health checks are single-flight and reused across nearby workspace requests', () => {
    assert.match(client, /const HEALTH_TTL_MS = 10000/);
    assert.match(client, /let healthPromise = null/);
    assert.match(client, /function healthIsFresh\(\)/);
    assert.match(client, /if \(!force && healthIsFresh\(\)\)/);
    assert.match(client, /if \(healthPromise\) return healthPromise/);
    assert.match(client, /lastHealthyAt = Date\.now\(\)/);
    assert.match(client, /A successful Notes API response itself proves the service is healthy/);
});

test('Notepad files and Spatial Notes keep visible feedback and directly bind critical controls', () => {
    assert.match(workspace, /data-eve-notes-status-toast/);
    assert.match(workspace, /input\.reportValidity\?\.\(\)/);
    assert.match(workspace, /data-eve-notes-track-path.*keydown/);
    assert.match(workspace, /function bindCriticalControls\(\)/);
    assert.match(workspace, /trackButton\.addEventListener\('click'/);
    assert.match(workspace, /querySelectorAll\('\[data-eve-notes-create\]'\)/);
    assert.match(workspace, /button\.addEventListener\('click'/);
    assert.match(workspace, /event\.stopPropagation\(\)/);
});

test('Tracking preserves the newly returned root instead of racing a stale workspace selection', () => {
    assert.match(workspace, /const rootId = String\(payload\.root\?\.id \|\| ''\)/);
    assert.match(workspace, /write\(ROOT_KEYS\.files, rootId\)/);
    assert.match(workspace, /refreshWorkspace\(\{ force: true, preferredRootId: rootId, preserve: true \}\)/);
    assert.match(workspace, /function normalizeTrackedPath\(value\)/);
});

test('Workspace metadata refreshes are coalesced during repeated activation', () => {
    assert.match(workspace, /const WORKSPACE_REFRESH_TTL_MS = 2500/);
    assert.match(workspace, /let workspaceRefreshPromise = null/);
    assert.match(workspace, /if \(!force && workspaceRefreshPromise\) return workspaceRefreshPromise/);
    assert.match(workspace, /Date\.now\(\) - lastWorkspaceAt/);
});

test('Notes workspace remains usable in the narrow embedded panel', () => {
    assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.eve-notes-trackbar \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
    assert.match(css, /\.eve-notes-browser \{[\s\S]*min-height: 540px/);
    assert.match(css, /\.eve-notes-status-toast/);
    assert.match(css, /overflow: auto/);
});
