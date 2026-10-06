'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('Gemini agentic dialog portal uses lifecycle events instead of document mutation rescans', () => {
    const source = read('js/modules/gemini/ui/agenticDialogPortal.js');

    assert.equal(
        source.includes('new MutationObserver('),
        false,
        'Agentic dialog portal must not create a MutationObserver for dialog discovery'
    );
    assert.equal(
        source.includes('observer.observe(document.documentElement'),
        false,
        'Agentic dialog portal must not rescan the whole EveOS document on subtree mutations'
    );
    assert.equal(
        source.includes("window.addEventListener('eve:gemini-workspace-ready', scan)"),
        true,
        'Agentic dialog portal must rescan when the Gemini workspace finishes mounting'
    );
    assert.equal(
        source.includes("window.addEventListener('eve:gemini-agentic-ui-refresh', scan)"),
        true,
        'Agentic dialog portal must retain an explicit refresh hook for later dialog changes'
    );
    assert.equal(
        source.includes('function start()'),
        true,
        'Agentic dialog portal must still perform its initial scan'
    );
});
