'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('Search Monitor scroll preservation stays passive during Gemini boot and coalesces mutation restores', () => {
    const source = read('js/modules/core/search-monitor-scroll-preserve.js');

    assert.equal(
        source.includes('function ensureObserver()'),
        true,
        'Scroll preservation must arm its observer lazily'
    );
    assert.equal(
        source.includes('if (observer || !tracked.size) return;'),
        true,
        'The mutation observer must remain disabled until the user has a tracked scroll position'
    );
    assert.match(
        source,
        /tracked\.add\(el\);\s+ensureObserver\(\);/,
        'The observer must only arm after genuine user scrolling creates tracked state'
    );
    assert.equal(
        source.includes('window.requestAnimationFrame(restoreAll);'),
        false,
        'Mutation delivery must not enqueue an unbounded RAF restore per callback'
    );
    assert.equal(
        source.includes('window.setTimeout(restoreAll, 120);'),
        false,
        'Mutation delivery must not enqueue an unbounded timeout restore per callback'
    );
    assert.equal(
        source.includes('if (!restoreFrame)'),
        true,
        'RAF restores must be single-flight/coalesced'
    );
    assert.equal(
        source.includes('if (!restoreTimer)'),
        true,
        'Delayed restores must be single-flight/coalesced'
    );
    assert.equal(
        source.includes("window.addEventListener(type, scheduleRestore)"),
        true,
        'Explicit lifecycle refreshes must remain available without polling or mutation storms'
    );
});
