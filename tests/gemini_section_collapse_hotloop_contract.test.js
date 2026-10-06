const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const collapsePath = path.join(
    root,
    'js',
    'modules',
    'gemini',
    'ui',
    'geminiSectionCollapse.js'
);
const manifestPath = path.join(
    root,
    'js',
    'config',
    'manifest',
    'scripts.parts',
    '13-gemini.js'
);

const collapse = fs.readFileSync(collapsePath, 'utf8');
const manifest = fs.readFileSync(manifestPath, 'utf8');

test('Gemini section collapse is event-driven instead of document-mutation driven', () => {
    assert.match(collapse, /const SECTION_SELECTOR = '\[data-collapsible-section\]';/);
    assert.match(collapse, /document\.addEventListener\('click', handleCollapseClick\)/);
    assert.match(collapse, /target\?\.closest\?\.\(HEADER_SELECTOR\)/);
    assert.match(collapse, /addEventListener\('eve:gemini-workspace-ready'/);
    assert.match(collapse, /initCollapsibleSections\(document\)/);
    assert.doesNotMatch(collapse, /new MutationObserver\s*\(/);
    assert.doesNotMatch(collapse, /observer\.observe\s*\(/);
    assert.doesNotMatch(collapse, /addedNodes/);
});

test('Gemini section collapse cache key changes with the hot-loop fix', () => {
    assert.match(manifest, /geminiSectionCollapse\.js\?v=20261005\.1/);
});
