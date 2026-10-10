'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const enginePath = path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.engine.js');
const fixture = path.join(os.tmpdir(), `eveos-spotify-seek-end-${process.pid}.html`);
const engineUrl = `file:///${enginePath.replace(/\\/g, '/')}`;
fs.writeFileSync(fixture, `<!doctype html><html><body><div id="spotify-engine-player"></div><script src="${engineUrl}"></script></body></html>`);

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://open.spotify.com/embed/iframe-api/v1', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: `
            window.onSpotifyIframeApiReady({
                createController: function (_mount, options, ready) {
                    var listeners = {};
                    var controller = window.__engineController = {
                        addListener: function (name, listener) { listeners[name] = listener; },
                        play: function () {},
                        resume: function () {},
                        pause: function () {},
                        seek: function () {},
                        loadUri: function () {},
                        emit: function (name, data) { if (listeners[name]) listeners[name]({ data: data }); }
                    };
                    ready(controller);
                    setTimeout(function () { controller.emit('ready', {}); }, 0);
                }
            });`
    }));

    try {
        await page.goto(`file:///${fixture.replace(/\\/g, '/')}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.EveAudioflixSpotifyEngine?.ready === true);
        const result = await page.evaluate(async () => {
            const engine = window.EveAudioflixSpotifyEngine;
            const id = '4cOdK2wGLETKBW3PvgPWqT';
            const update = (position, isPaused = false) => window.__engineController.emit('playback_update', {
                playingURI: `spotify:track:${id}`, position, duration: 30030, isPaused
            });
            const start = async (generation) => {
                await engine.command('load', { spotifyId: id, title: 'Seek reset', duration: 30.03, generation });
                await engine.command('play');
                window.__engineController.emit('playback_started', {});
                update(1000, false);
                update(5000, false);
            };

            await start(21);
            const nearSeek = await engine.command('seek', { seconds: 27.53 });
            update(27530, true);
            const tailPause = engine.snapshot();
            update(0, true);
            const naturalReset = engine.snapshot();
            const naturalCompletionId = naturalReset.completionId;
            update(0, true);
            const duplicateReset = engine.snapshot();

            await start(22);
            await engine.command('seek', { seconds: 20 });
            update(0, true);
            const midTrackReset = engine.snapshot();

            await start(23);
            await engine.command('seek', { seconds: 27.53 });
            await engine.command('pause');
            update(0, true);
            const explicitPauseReset = engine.snapshot();

            await start(24);
            await engine.command('seek', { seconds: 27.53 });
            update(10000, false);
            update(0, true);
            const failedSeekReset = engine.snapshot();

            return {
                nearSeek, tailPause, naturalReset, naturalCompletionId, duplicateReset,
                midTrackReset, explicitPauseReset, failedSeekReset
            };
        });

        assert.equal(result.nearSeek.status, 'playing');
        assert.equal(result.nearSeek.currentTime, 27.53);
        assert.equal(result.tailPause.ended, false, 'a provider pause inside the requested tail is not completion by itself');
        assert.equal(result.tailPause.status, 'provider-paused');
        assert.equal(result.naturalReset.status, 'ended', 'same-generation paused/zero reset after a successful near-end seek is completion');
        assert.equal(result.naturalReset.ended, true);
        assert.equal(result.naturalReset.generation, 21);
        assert.equal(result.naturalReset.currentTime, 30.03);
        assert.ok(result.naturalCompletionId.startsWith('21:'), 'near-end seek reset gets one durable completion identity');
        assert.equal(result.duplicateReset.completionId, result.naturalCompletionId, 'duplicate paused/zero reset cannot duplicate completion');

        assert.equal(result.midTrackReset.ended, false, 'ordinary mid-track seek followed by zero is not inferred as completion');
        assert.equal(result.midTrackReset.status, 'provider-paused');
        assert.equal(result.explicitPauseReset.ended, false, 'explicit Pause clears the near-end seek completion candidate');
        assert.equal(result.failedSeekReset.ended, false, 'provider progress far from the requested tail clears a stale seek completion candidate');

        console.log('AUDIOFLIX_SPOTIFY_SEEK_END_RESET_SMOKE_OK');
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }
})().catch((error) => { console.error(error); process.exit(1); });
