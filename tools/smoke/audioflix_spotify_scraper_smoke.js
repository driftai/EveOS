'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const { mergeTrack, launchContext } = require(path.resolve(__dirname, '..', '..', 'server_modules', 'audioflix_spotify_scrape.js'));

const merged = mergeTrack(null, {
    title: 'Purpose Is Glorious',
    artists: ['Natalie Holt'],
    durationText: '3:08',
    url: 'https://open.spotify.com/track/example123456'
});

if (merged.title !== 'Purpose Is Glorious'
    || merged.artist !== 'Natalie Holt'
    || merged.duration !== 188) {
    throw new Error('ASSERT FAILED: DOM-only Spotify rows must merge without a network record.');
}

async function checkLaunch() {
    const profile = path.resolve('fixture-managed-spotify-profile');
    const attempts = [];
    const browser = {
        async launchPersistentContext(directory, options) {
            attempts.push({ directory, options });
            throw new Error('fixture: profile busy');
        }
    };
    for (const headed of [false, true]) {
        const before = attempts.length;
        await assert.rejects(launchContext(browser, profile, headed), /fixture: profile busy/);
        assert.equal(attempts.length, before + 1, 'a failed launch cannot switch browsers');
        const { directory, options } = attempts.at(-1);
        assert.equal(directory, profile);
        assert.equal(options.headless, !headed);
        if (process.platform === 'win32') {
            assert.match(options.executablePath, /[\\/]Edge Beta[\\/]Application[\\/]msedge\.exe$/i);
        }
    }
}

checkLaunch().then(() => console.log('AUDIOFLIX_SPOTIFY_SCRAPER_SMOKE_OK')).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
