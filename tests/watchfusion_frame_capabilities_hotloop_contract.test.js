'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('WatchFusion frame capabilities stay dormant during unrelated DOM churn and remain file-safe', () => {
    const source = read('js/modules/features/watchfusion/watchfusion.frame-capabilities.js');
    const bootstrap = read('js/modules/features/watchfusion/watchfusion.bootstrap.js');
    const watchfusion = read('js/modules/features/watchfusion/watchfusion.js');
    const manifest = read('js/config/manifest/scripts.parts/03-feature-modules.js');

    assert.equal(
        source.includes('observer.observe(document.documentElement, { childList: true, subtree: true });'),
        false,
        'Frame capabilities must not watch the entire EveOS document during unrelated workspace churn'
    );
    assert.equal(
        source.includes("window.addEventListener('eve:watchfusion-status', () => patchFrame());"),
        true,
        'Frame binding must use the existing WatchFusion lifecycle edge'
    );
    assert.equal(
        source.includes("frameObserver.observe(frame, { attributes: true, attributeFilter: ['hidden', 'src'] });"),
        true,
        'After binding, observation must stay scoped to the WatchFusion iframe only'
    );
    assert.equal(
        source.includes('location.protocol') || source.includes('window.location.protocol'),
        false,
        'Frame capability binding must not be gated on http(s), so file:// EveOS follows the same path'
    );
    assert.match(
        bootstrap,
        /watchfusion\.frame-capabilities\.js\?v=55673348c982/,
        'The bootstrap cache key must expose the restored frame-isolation runtime'
    );
    assert.equal(
        watchfusion.includes("new CustomEvent('eve:watchfusion-status'"),
        true,
        'WatchFusion must continue emitting the lifecycle event after overlay/status rendering'
    );
    assert.match(
        manifest,
        /watchfusion\/watchfusion\.bootstrap\.js\?v=b2bb72130891/,
        'The main manifest must expose the refreshed WatchFusion bootstrap'
    );
});
