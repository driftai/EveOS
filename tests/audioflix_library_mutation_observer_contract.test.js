'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const audioflixDir = path.join(__dirname, '..', 'js', 'modules', 'features', 'audioflix');
const librarySource = fs.readFileSync(path.join(audioflixDir, 'audioflix.library.next.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(audioflixDir, 'audioflix.library.next.ui.js'), 'utf8');

test('library decorators inspect added AudioFlix subtrees instead of rescanning the document', () => {
    assert.match(librarySource, /function scanDomDecorators\(root\)/);
    assert.match(librarySource, /function installOverlayDomObserver\(\)/);
    assert.match(librarySource, /record\.addedNodes\.forEach/);
    assert.match(librarySource, /scanDomDecorators\(node\)/);

    assert.doesNotMatch(
        librarySource,
        /new MutationObserver\(\(\) => \{[\s\S]*?document\.querySelectorAll\('\.audioflix-info-modal'\)/,
        'AudioFlix mutations must not trigger a full-document modal scan'
    );
    assert.doesNotMatch(
        librarySource,
        /new MutationObserver\(\(\) => \{[\s\S]*?document\.querySelectorAll\('\.audioflix-dup-manager-box'\)/,
        'AudioFlix mutations must not trigger a full-document duplicate-manager scan'
    );
});

test('library marker observer keeps queue and marker work inside the AudioFlix overlay', () => {
    assert.match(uiSource, /function injectMarkers\(root\)/);
    assert.match(uiSource, /function containsAudioflixCard\(root\)/);
    assert.match(uiSource, /function containsQueueGrid\(root\)/);
    assert.match(uiSource, /function handleOverlayMutations\(records\)/);
    assert.match(uiSource, /record\.addedNodes\.forEach/);
    assert.match(uiSource, /record\.removedNodes\.forEach/);
    assert.match(uiSource, /const overlay = audioflixOverlay\(\);/);
    assert.match(uiSource, /overlay\.querySelectorAll\('\.audioflix-item-grid\[data-af-active-group\]'\)/);
    assert.doesNotMatch(
        uiSource,
        /document\.querySelectorAll\('\.audioflix-item-card'\)/,
        'marker injection must scan only the supplied AudioFlix subtree'
    );
    assert.doesNotMatch(
        uiSource,
        /document\.querySelectorAll\('\.audioflix-item-grid\[data-af-active-group\]'\)/,
        'queue rebase lookup must stay inside the AudioFlix overlay'
    );
});

test('AudioFlix library observers never subscribe to the whole document.body subtree', () => {
    const globalBodySubtreeObserver = /\.observe\(document\.body,\s*\{\s*childList:\s*true,\s*subtree:\s*true\s*\}\)/;
    for (const [name, source] of [['library', librarySource], ['marker ui', uiSource]]) {
        assert.doesNotMatch(
            source,
            globalBodySubtreeObserver,
            `${name} must not receive Search Monitor/Gemini subtree mutations`
        );
        assert.match(source, /document\.getElementById\('audioflix-overlay'\)/);
        assert.match(source, /\.observe\(overlay,\s*\{\s*childList:\s*true,\s*subtree:\s*true\s*\}\)/);
        assert.match(
            source,
            /bodyObserver\.observe\(document\.body,\s*\{\s*childList:\s*true\s*\}\)/,
            `${name} may only watch direct body children while waiting for the AudioFlix overlay`
        );
        assert.match(source, /bodyObserver\?\.disconnect\(\)/);
    }
});