'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('World Book narration binding is lifecycle-driven instead of document-mutation driven', () => {
    const source = read('js/modules/features/world-book/world-book.narration.agentic.js');

    assert.equal(
        source.includes('new MutationObserver('),
        false,
        'Narration binding must not create a MutationObserver for dialog discovery'
    );
    assert.equal(
        source.includes('observer.observe(document.documentElement'),
        false,
        'Narration binding must not rescan the whole EveOS document on subtree mutations'
    );
    assert.equal(
        source.includes("window.addEventListener('eve:gemini-workspace-ready', sync)"),
        true,
        'Narration binding must resync when the Gemini workspace finishes mounting'
    );
    assert.equal(
        source.includes("window.addEventListener('eve:world-book-ready', sync)"),
        true,
        'Narration binding must resync when World Book finishes mounting'
    );
    assert.equal(
        source.includes("window.addEventListener('eve:world-book-narration-settings', sync)"),
        true,
        'Narration binding must keep the explicit narration-settings refresh path'
    );
    assert.equal(
        source.includes("window.speechSynthesis?.addEventListener?.('voiceschanged', sync)"),
        true,
        'Narration binding must keep browser voice-list refreshes'
    );
});
