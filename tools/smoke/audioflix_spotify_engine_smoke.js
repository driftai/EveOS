'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const enginePath = path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.engine.js');
const engineHtmlPath = path.join(ROOT, 'audioflix-spotify-engine.html');
const surfacePath = path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.engine-surface.js');
const launcherPath = path.join(ROOT, 'tools/audioflix/spotify-managed-browser.ps1');
const fixture = path.join(os.tmpdir(), `eveos-spotify-engine-${process.pid}.html`);
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
                    var calls = window.__engineCalls = { uri: options.uri, play: 0, resume: 0, pause: 0, seek: [], load: [] };
                    var controller = window.__engineController = {
                        addListener: function (name, listener) { listeners[name] = listener; },
                        play: function () { calls.play += 1; },
                        resume: function () { calls.resume += 1; },
                        pause: function () { calls.pause += 1; },
                        seek: function (seconds) { calls.seek.push(seconds); },
                        loadUri: function (uri) { calls.load.push(uri); },
                        destroy: function () {},
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
            await engine.command('load', {
                spotifyId: '4cOdK2wGLETKBW3PvgPWqT', title: 'Engine smoke', duration: 180, generation: 7
            });
            const afterLoad = engine.snapshot();
            await engine.command('play');
            window.__engineController.emit('playback_started', {});
            window.__engineController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 45000, duration: 180000, isPaused: false
            });
            const resumeBeforeProviderPause = window.__engineCalls.resume;
            window.__engineController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 46000, duration: 180000, isPaused: true
            });
            const providerPaused = engine.snapshot();
            const noAutoResume = window.__engineCalls.resume === resumeBeforeProviderPause;
            await engine.command('play');
            const deliberateResume = window.__engineCalls.resume === resumeBeforeProviderPause + 1;
            window.__engineController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 179200, duration: 180000, isPaused: false
            });
            window.__engineController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 0, duration: 180000, isPaused: true
            });
            const endedOnce = engine.snapshot();
            window.__engineController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 0, duration: 180000, isPaused: true
            });
            const endedTwice = engine.snapshot();
            await engine.command('restart', { generation: 8 });
            const afterRestart = engine.snapshot();
            await engine.command('seek', { seconds: 33 });
            return {
                afterLoad, providerPaused, noAutoResume, deliberateResume,
                endedOnce, endedTwice, afterRestart,
                calls: { ...window.__engineCalls }, afterSeek: engine.snapshot()
            };
        });

        assert.equal(result.afterLoad.generation, 7);
        assert.equal(result.afterLoad.spotifyId, '4cOdK2wGLETKBW3PvgPWqT');
        assert.equal(result.providerPaused.status, 'provider-paused');
        assert.equal(result.noAutoResume, true, 'engine never steals an ambiguous provider-origin pause');
        assert.equal(result.deliberateResume, true, 'explicit engine play resumes paused playback');
        assert.equal(result.endedOnce.status, 'ended');
        assert.ok(result.endedOnce.completionId, 'real provider end evidence receives a completion identity');
        assert.equal(result.endedTwice.completionId, result.endedOnce.completionId,
            'duplicate provider end evidence is deduplicated for the same generation');
        assert.equal(result.afterRestart.generation, 8, 'restart starts a fresh playback generation');
        assert.equal(result.afterRestart.completionId, '', 'restart clears the prior generation completion identity');
        assert.equal(result.afterSeek.currentTime, 33);
        assert.ok(result.calls.load.includes('spotify:track:4cOdK2wGLETKBW3PvgPWqT'));

        const mirrorPage = await browser.newPage();
        const mirrorUrl = `file:///${engineHtmlPath.replace(/\\/g, '/')}?surface=mirror`;
        await mirrorPage.goto(mirrorUrl, { waitUntil: 'load' });
        await mirrorPage.waitForFunction(() => document.documentElement.dataset.spotifyEngineSurface === 'mirror');
        assert.equal(await mirrorPage.evaluate(() => Boolean(window.EveAudioflixSpotifyEngine)), false,
            'embedded engine mirror never creates a second Spotify playback engine');
        await mirrorPage.evaluate(() => window.postMessage({
            type: 'eveos:spotify-engine-mirror-state', version: 1,
            state: { title: 'Mirror smoke', status: 'playing', currentTime: 30, duration: 120, paused: false }
        }, '*'));
        await mirrorPage.waitForFunction(() => document.querySelector('[data-engine-mirror-title]')?.textContent === 'Mirror smoke');
        assert.equal(await mirrorPage.locator('[data-engine-mirror-status]').textContent(), 'playing');
        assert.equal(await mirrorPage.locator('[data-engine-mirror-time]').textContent(), '0:30 / 2:00');
        await mirrorPage.close();

        const surface = fs.readFileSync(surfacePath, 'utf8');
        assert(surface.includes('audioflix-spotify-engine.html?surface=mirror')
            && surface.includes('originalOpenInternalView')
            && surface.includes('managedActive()'),
        'ordinary EveOS Internal View mirrors the managed engine only when managed playback owns Spotify');
        const launcher = fs.readFileSync(launcherPath, 'utf8');
        assert(launcher.includes("[ValidateSet('background','window')]")
            && launcher.includes('ShowWindowAsync')
            && launcher.includes("Set-SpotifyEnginePresentation $Presentation"),
        'managed Spotify launcher exposes background and visible-window presentation modes');

        console.log('AUDIOFLIX_SPOTIFY_ENGINE_SMOKE_OK');
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }
})().catch((error) => { console.error(error); process.exit(1); });