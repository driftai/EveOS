'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'js/modules/features/world-book/world-book.client.js'), 'utf8');

test('World Book lifecycle discovery coalesces bursty status consumers without slowing start-stop waits', () => {
    assert.match(source, /const REFRESH_TTL_MS = 4000/);
    assert.match(source, /if \(refreshPromise\) return refreshPromise/);
    assert.match(source, /Date\.now\(\) - lastRefreshAt/);
    assert.match(source, /const snapshot = await refresh\(true\)/);
    assert.match(source, /window\.setTimeout\(\(\) => \{ void refresh\(true\); \}, 0\)/);
});
