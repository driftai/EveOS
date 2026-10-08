'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const managedImport = require(path.join(ROOT, 'server_modules', 'audioflix_spotify_managed_import.js'));

(async () => {
    const privateShare = 'https://open.spotify.com/playlist/1fY2i6tthQptx5Z3nn1g17?si=a60e8f62ad464b26&pt=48ecfbe39b719caf600d2c23196f587e';
    const normalized = managedImport.normalizeManagedPlaylistUrl(privateShare);
    assert.equal(normalized, privateShare, 'private pt= capability URL is preserved exactly');
    assert.equal(managedImport.normalizeManagedPlaylistUrl('https://example.com/playlist/abc'), '',
        'managed import rejects non-Spotify origins');

    let pageClosed = 0;
    let contextClosed = 0;
    const page = { close: async () => { pageClosed += 1; } };
    const context = {
        newPage: async () => page,
        close: async () => { contextClosed += 1; }
    };
    const result = await managedImport.withManagedPlaylistPage(context, privateShare, async (receivedPage, receivedUrl) => {
        assert.equal(receivedPage, page);
        assert.equal(receivedUrl, privateShare);
        return { ok: true, count: 163 };
    });
    assert.equal(result.count, 163);
    assert.equal(pageClosed, 1, 'temporary import page closes after success');
    assert.equal(contextClosed, 0, 'managed BrowserContext/EveOS stays alive after import');

    pageClosed = 0;
    await assert.rejects(
        managedImport.withManagedPlaylistPage(context, privateShare, async () => { throw new Error('fixture failure'); }),
        /fixture failure/
    );
    assert.equal(pageClosed, 1, 'temporary import page closes after failure');
    assert.equal(contextClosed, 0, 'failed import never closes managed BrowserContext/EveOS');

    const helper = fs.readFileSync(path.join(ROOT, 'server_modules', 'audioflix_spotify_browser.js'), 'utf8');
    const bridge = fs.readFileSync(path.join(ROOT, 'server_modules', 'audioflix_bridge.py'), 'utf8');
    assert(helper.includes("requestUrl.pathname === '/playlist'") && helper.includes('scrapeManagedPlaylist(context, url)'),
        'managed helper owns a fixed in-context playlist command');
    assert(bridge.includes('audioflix_spotify_browser.list_playlist')
        && !bridge.includes('suspend_for_profile_task("playlist-import")'),
        'browser-origin playlist import no longer shuts down the browser that issued the request');

    console.log('AUDIOFLIX_SPOTIFY_MANAGED_IMPORT_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
