'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const UI_MAIN = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.ui.js');
const SPOTIFY_VOLUME = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.spotify.volume.js');
const moduleUrl = (name) => `file:///${path.join(ROOT, 'js', 'modules', 'features', 'audioflix', name).replace(/\\/g, '/')}`;
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };

function runChild(runtime, relative) {
    const command = runtime === 'python'
        ? (process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'))
        : process.execPath;
    const result = spawnSync(command, [path.join(ROOT, relative)], { cwd: ROOT, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${relative} failed with exit ${result.status}`);
}

(async () => {
    const uiMain = fs.readFileSync(UI_MAIN, 'utf8');
    const spotifyVolume = fs.readFileSync(SPOTIFY_VOLUME, 'utf8');
    assert(uiMain.includes("status === 'Ended'") && uiMain.includes('playQueueIndex(expectedIndex + 1)'),
        'frontend queue remains the sole owner that consumes Spotify Ended and advances');
    assert(spotifyVolume.includes('__EveAudioflixManagedBrowserSession')
        && spotifyVolume.includes("api('/volume'"),
        'Spotify volume uses the managed-browser session contract');
    assert(!spotifyVolume.includes('getDisplayMedia') && !spotifyVolume.includes('createMediaStreamSource'),
        'Spotify volume never regresses to tab/screen capture');

    const fixture = path.join(os.tmpdir(), `eveos-spotify-playback-${process.pid}.html`);
    const scripts = [
        'audioflix.audio.source.js',
        'audioflix.audio.internal.js',
        'audioflix.audio.url.loaders.js',
        'audioflix.audio.url.widgets.js',
        'audioflix.audio.url.providers.js',
        'audioflix.spotify.volume.js',
        'audioflix.spotify.completion.js',
        'audioflix.audio.url.spotify.js',
        'audioflix.audio.url.js'
    ].map((name) => `<script src="${moduleUrl(name)}"></script>`).join('');
    fs.writeFileSync(fixture, `<!doctype html><html><body><script>
        window.__EveAudioflixSpotifyStartTimeoutMs=80;
        window.__EveAudioflixSpotifyUnexpectedPauseRetryMs=0;
    </script>${scripts}</body></html>`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://open.spotify.com/embed/iframe-api/v1', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: `
            window.onSpotifyIframeApiReady({
                createController: function (_mount, options, ready) {
                    var listeners = {};
                    var calls = window.__spotifyCalls = {
                        uri: options.uri, play: 0, resume: 0, pause: 0, seek: [], destroy: 0, loaded: [], controllers: (window.__spotifyControllers || 0) + 1
                    };
                    window.__spotifyControllers = calls.controllers;
                    var controller = window.__spotifyController = {
                        addListener: function (name, listener) { listeners[name] = listener; },
                        play: function () { calls.play += 1; },
                        resume: function () { calls.resume += 1; },
                        pause: function () { calls.pause += 1; },
                        seek: function (seconds) { calls.seek.push(seconds); },
                        loadUri: function (uri) { calls.loaded.push(uri); },
                        destroy: function () { calls.destroy += 1; },
                        emit: function (name, data) { if (listeners[name]) listeners[name]({ data: data }); }
                    };
                    ready(controller);
                    setTimeout(function () { controller.emit('ready', {}); }, 0);
                }
            });`
    }));

    try {
        await page.goto(`file:///${fixture.replace(/\\/g, '/')}`, { waitUntil: 'load' });
        const result = await page.evaluate(async () => {
            const playback = [];
            const progress = [];
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const player = window.EveAudioflixUrlPlayback.createController({
                onPlayback: (detail) => playback.push(detail),
                onProgress: (detail) => progress.push(detail)
            });
            const first = {
                id: 'spotify-one', type: 'music', sourceProvider: 'spotify', title: 'First',
                url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', volume: 0.4, duration: 180
            };
            const second = {
                id: 'spotify-two', type: 'music', sourceProvider: 'spotify', title: 'Second',
                url: 'https://open.spotify.com/track/1WZGaNYzreZrvteuUEfp8X', volume: 0.6, duration: 200
            };
            await player.play(first);
            const volumeSnapshot = window.EveAudioflixSpotifyVolume.snapshot();
            window.__spotifyController.emit('playback_started', {});
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 42000, duration: 180000, isPaused: false
            });

            // A provider-side mid-track pause that was not requested by Audioflix gets one bounded
            // resume attempt instead of leaving a long song silently stuck halfway through.
            const resumeBeforeRecovery = window.__spotifyCalls.resume;
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 43000, duration: 180000, isPaused: true
            });
            await sleep(10);
            const recoveredUnexpectedPause = window.__spotifyCalls.resume === resumeBeforeRecovery + 1;
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 43500, duration: 180000, isPaused: false
            });

            await player.seek(61);
            await player.pause();
            const resumeAfterManualPause = window.__spotifyCalls.resume;
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 61000, duration: 180000, isPaused: true
            });
            await sleep(10);
            const manualPauseStayedPaused = window.__spotifyCalls.resume === resumeAfterManualPause;

            const playBeforeResume = window.__spotifyCalls.play;
            const resumeBeforeResume = window.__spotifyCalls.resume;
            await player.play(first);
            const resumed = window.__spotifyCalls.play === playBeforeResume
                && window.__spotifyCalls.resume === resumeBeforeResume + 1;
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 62000, duration: 180000, isPaused: false
            });

            // Prove exactly-once completion shape and that near-end pauses are never "recovered".
            const resumeBeforeEnd = window.__spotifyCalls.resume;
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 179300, duration: 180000, isPaused: false
            });
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 0, duration: 180000, isPaused: true
            });
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', position: 0, duration: 180000, isPaused: true
            });
            await sleep(10);
            const nearEndDidNotRecover = window.__spotifyCalls.resume === resumeBeforeEnd;
            const endedAfterFirst = playback.filter((entry) => entry.status === 'Ended').length;
            const firstEndedId = playback.filter((entry) => entry.status === 'Ended').at(-1)?.item?.id;

            const controllersBefore = window.__spotifyControllers;
            await player.play(second);
            const reused = window.__spotifyControllers === controllersBefore
                && window.__spotifyCalls.loaded.includes('spotify:track:1WZGaNYzreZrvteuUEfp8X');
            window.__spotifyController.emit('playback_started', {});
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:1WZGaNYzreZrvteuUEfp8X', position: 199100, duration: 200000, isPaused: false
            });
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:1WZGaNYzreZrvteuUEfp8X', position: 199200, duration: 200000, isPaused: true
            });
            const endedTotal = playback.filter((entry) => entry.status === 'Ended').length;
            const secondEndedId = playback.filter((entry) => entry.status === 'Ended').at(-1)?.item?.id;
            await player.stop();
            return {
                uri: window.__spotifyCalls.uri,
                seek: window.__spotifyCalls.seek,
                destroy: window.__spotifyCalls.destroy,
                resumed,
                reused,
                recoveredUnexpectedPause,
                manualPauseStayedPaused,
                nearEndDidNotRecover,
                endedAfterFirst,
                endedTotal,
                firstEndedId,
                secondEndedId,
                progress42: progress.some((entry) => entry.currentTime === 42 && entry.duration === 180),
                volumeSnapshot,
                needsResolution: window.EveAudioflixAudioSource.needsResolution(first.url)
            };
        });

        assert(result.uri === 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', 'Spotify URI is normalized for official embed');
        assert(result.progress42, 'Spotify progress milliseconds convert to seconds');
        assert(result.seek.includes(61), 'Spotify seek remains in seconds');
        assert(result.recoveredUnexpectedPause, 'unexpected mid-track provider pause gets a bounded resume attempt');
        assert(result.manualPauseStayedPaused, 'explicit Audioflix pause is never auto-resumed');
        assert(result.nearEndDidNotRecover, 'near-end pause remains completion evidence, not recovery evidence');
        assert(result.resumed, 'paused Spotify item resumes instead of restarting');
        assert(result.reused, 'back-to-back Spotify items reuse the existing controller');
        assert(result.endedAfterFirst === 1 && result.firstEndedId === 'spotify-one', 'first item emits Ended exactly once');
        assert(result.endedTotal === 2 && result.secondEndedId === 'spotify-two', 'second item emits its own Ended exactly once');
        assert(result.destroy === 1, 'stop destroys provider controller once');
        assert(result.volumeSnapshot.directControl === false,
            'ordinary unmanaged browser honestly leaves Spotify volume provider-owned');
        assert(result.needsResolution === false, 'Spotify identity never enters generic URL resolution');
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }

    // These child smokes are intentionally invoked here so the repo smoke-registry audit follows
    // them transitively from the already-registered Spotify playback chain.
    runChild('node', 'tools/smoke/audioflix_spotify_browser_contract_smoke.js');
    runChild('node', 'tools/smoke/audioflix_spotify_browser_runtime_smoke.js');
    runChild('python', 'tools/smoke/audioflix_spotify_browser_python_smoke.py');
    runChild('node', 'tools/smoke/audioflix_volume_managed_smoke.js');

    console.log('AUDIOFLIX_SPOTIFY_PLAYBACK_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
