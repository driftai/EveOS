const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inspectorPath = path.join(
    root,
    'js',
    'modules',
    'gemini',
    'server_control',
    'geminiServerInspector.js'
);
const manifestPath = path.join(
    root,
    'js',
    'config',
    'manifest',
    'scripts.parts',
    '13-gemini.js'
);

const inspector = fs.readFileSync(inspectorPath, 'utf8');
const manifest = fs.readFileSync(manifestPath, 'utf8');

test('Gemini server inspector uses delegated toggle binding instead of a document mutation rescan', () => {
    assert.match(inspector, /const INSPECTOR_TOGGLE_SELECTOR = '\[data-gemini-server-inspector-toggle\]';/);
    assert.match(inspector, /document\.addEventListener\('click', handleInspectorToggleClick\);/);
    assert.match(inspector, /target\?\.closest\?\.\(INSPECTOR_TOGGLE_SELECTOR\)/);
    assert.doesNotMatch(inspector, /new MutationObserver\s*\(/);
    assert.doesNotMatch(inspector, /observer\.observe\(document\.documentElement/);
    assert.doesNotMatch(inspector, /bind\(document\)/);
});

test('Gemini server inspector cache key changes with the hot-loop fix', () => {
    assert.match(manifest, /geminiServerInspector\.js\?v=[a-f0-9]{12}/);
});
