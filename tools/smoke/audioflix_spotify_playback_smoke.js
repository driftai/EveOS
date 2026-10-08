const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const UI_ACTIONS = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.ui.actions.js');
const UI_MAIN = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.ui.js');
const PROVIDER_CSS = `file:///${path.join(
    ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.provider.css'
).replace(/\\/g, '/')}`;
const moduleUrl = (name) => `file:///${path.join(
    ROOT,
    'js',
    'modules',
    'features',
    'audioflix',
    name
).replace(/\\/g, '/')}`;
const assert = (condition, message) => {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
};

(async () => {
    const uiActions = fs.readFileSync(UI_ACTIONS, 'utf8');
    const uiMain = fs.readFileSync(UI_MAIN, 'utf8');
    assert(/EveAudioflixAudio\?\.playItem\?\.\(\{\s*\.\.\.item,\s*type:\s*type\s*\|\|\s*item\.type\s*\}\)/.test(uiActions),
        'regular card play uses the shared Audioflix controller with its UI media type');
    assert(uiActions.includes('await ctx.playQueueIndex(0)'),
        'frontend group play enters the serialized queue controller');
    assert(uiMain.includes('await window.EveAudioflixAudio?.playItem?.(track)'),
        'serialized queue playback delegates to the shared Audioflix controller');
    assert(uiMain.includes("status === 'Ended'") && uiMain.includes('playQueueIndex(expectedIndex + 1)'),
        'frontend queue consumes Ended and advances to the next track');
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
    fs.writeFileSync(fixture, `<!doctype html><html><head><link rel="stylesheet" href="${PROVIDER_CSS}"></head><body><script>window.__EveAudioflixSpotifyStartTimeoutMs = 60;</script>${scripts}</body></html>`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('https://open.spotify.com/embed/iframe-api/v1', (route) => route.fulfill({
        contentType: 'application/javascript',
        body: `
            window.onSpotifyIframeApiReady({
                createController: function (_mount, options, ready) {
                    var listeners = {};
                    var calls = window.__spotifyCalls = {
                        uri: options.uri, play: 0, resume: 0, pause: 0, seek: [], destroy: 0,
                        loaded: [], legacyLoaded: [], controllers: (window.__spotifyControllers || 0) + 1
                    };
                    window.__spotifyControllers = calls.controllers;
                    var controller = window.__spotifyController = {
                        addListener: function (name, listener) { listeners[name] = listener; },
                        play: function () { calls.play += 1; },
                        resume: function () { calls.resume += 1; },
                        pause: function () { calls.pause += 1; },
                        seek: function (seconds) { calls.seek.push(seconds); },
                        loadUri: function (uri) { calls.loaded.push(uri); },
                        loadEntity: function (uri) { calls.legacyLoaded.push(uri); },
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
            const events = [];
            const playbackDetails = [];
            const progress = [];
            const player = window.EveAudioflixUrlPlayback.createController({
                onPlayback: (detail) => { events.push(detail.status); playbackDetails.push(detail); },
                onProgress: (detail) => progress.push(detail)
            });
            const item = {
                id: 'spotify-track',
                title: 'Mobius',
                url: 'https://open.spotify.com/track/1234567890ABCDEF',
                volume: 0.7
            };
            await player.play(item);
            const volumeBar = document.querySelector('.audioflix-provider-stage .af-spotify-volume')?.textContent || '';
            const volumeWhilePlaying = window.EveAudioflixSpotifyVolume.snapshot();
            const stage = document.querySelector('.audioflix-provider-stage');
            const mainCardTransportOnly = stage?.classList.contains('is-transport-only') === true
                && stage.hidden === false
                && player.isInternalViewOpen() === false;
            const compactTransportHidden = stage?.classList.contains('is-transport-hidden') === true
                && Number.parseFloat(getComputedStyle(stage).opacity) > 0
                && stage.getBoundingClientRect().left < innerWidth
                && stage.getBoundingClientRect().right > 0;
            window.__spotifyController.emit('playback_started', {});
            await player.openInternalView(item);
            const internalExpanded = stage?.classList.contains('is-internal-view') === true
                && stage.classList.contains('is-transport-only') === false
                && player.isInternalViewOpen() === true;
            window.__spotifyController.emit('playback_update', {
                position: 42000,
                duration: 180000,
                isPaused: false
            });
            window.__spotifyController.emit('playback_error', {});
            const runtimeError = events.at(-1);
            const runtimeErrorVisible = document.querySelector('.audioflix-provider-stage')?.classList.contains('has-error');
            await player.seek(61);
            await player.pause();
            const playBeforePausedResume = window.__spotifyCalls.play;
            const resumeBeforePausedResume = window.__spotifyCalls.resume;
            await player.play(item);
            const pausedResumeUsed = window.__spotifyCalls.play === playBeforePausedResume
                && window.__spotifyCalls.resume === resumeBeforePausedResume + 1;
            // Real Spotify embeds do not expose a dedicated ended event. A finished track may
            // report one final near-end playing position and then rewind to zero as it pauses.
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:1234567890ABCDEF',
                position: 179200,
                duration: 180000,
                isPaused: false
            });
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:1234567890ABCDEF',
                position: 0,
                duration: 180000,
                isPaused: true
            });
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:1234567890ABCDEF',
                position: 0,
                duration: 180000,
                isPaused: true
            });
            const firstEndedItemId = playbackDetails.filter((detail) => detail.status === 'Ended').at(-1)?.item?.id;
            const nextItem = {
                id: 'spotify-track-two',
                title: 'Next Spotify Track',
                url: 'https://open.spotify.com/track/ABCDEF1234567890',
                volume: 0.6
            };
            const playBeforeNextLoad = window.__spotifyCalls.play;
            const resumeBeforeNextLoad = window.__spotifyCalls.resume;
            await player.play(nextItem);
            const reusedController = window.__spotifyControllers === 1
                && window.__spotifyCalls.loaded.includes('spotify:track:ABCDEF1234567890')
                && window.__spotifyCalls.legacyLoaded.length === 0;
            const nextLoadUsedPlay = window.__spotifyCalls.play === playBeforeNextLoad + 1
                && window.__spotifyCalls.resume === resumeBeforeNextLoad;
            // The terminal paused update can also land slightly short of the nominal duration.
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:ABCDEF1234567890',
                position: 199000,
                duration: 200000,
                isPaused: false
            });
            window.__spotifyController.emit('playback_update', {
                playingURI: 'spotify:track:ABCDEF1234567890',
                position: 199100,
                duration: 200000,
                isPaused: true
            });
            const secondEndedItemId = playbackDetails.filter((detail) => detail.status === 'Ended').at(-1)?.item?.id;
            player.hideInternalView();
            const closePreservedTransport = stage?.hidden === false
                && stage.classList.contains('is-transport-only') === true
                && player.isInternalViewOpen() === false;
            const activeAfterHide = player.isActive();
            await player.play(item);
            const resumedFromMainCard = window.__spotifyCalls.play >= 3;
            await player.stop();
            const volumeAfterStop = window.EveAudioflixSpotifyVolume.snapshot();
            const firstCalls = {
                ...window.__spotifyCalls,
                seek: [...window.__spotifyCalls.seek]
            };
            const stalledErrorsBefore = events.filter((status) => status.includes('direct click')).length;
            await player.openInternalView({
                id: 'spotify-blocked',
                title: 'Blocked track',
                url: 'https://open.spotify.com/track/FEDCBA0987654321',
                showProviderTransport: true
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            const stalledStatus = document.querySelector('.audioflix-provider-status')?.textContent || '';
            const stalledTransportVisible = stage?.classList.contains('is-transport-hidden') === false;
            const stalledState = player.getPlaybackState();
            const stalledErrorCount = events.filter((status) => status.includes('direct click')).length
                - stalledErrorsBefore;
            await player.stop();
            return {
                volumeBar,
                volumeWhilePlaying,
                volumeAfterStop,
                calls: firstCalls,
                stateAt42: progress.find((entry) => entry.currentTime === 42),
                endedCount: events.filter((status) => status === 'Ended').length,
                firstEndedItemId,
                mainCardTransportOnly,
                compactTransportHidden,
                internalExpanded,
                closePreservedTransport,
                activeAfterHide,
                resumedFromMainCard,
                pausedResumeUsed,
                nextLoadUsedPlay,
                runtimeError,
                runtimeErrorVisible,
                stalledStatus,
                stalledTransportVisible,
                stalledState,
                stalledErrorCount,
                reusedController,
                secondEndedItemId,
                spotifyNeedsResolution: window.EveAudioflixAudioSource.needsResolution(item.url)
            };
        });

        assert(result.calls.uri === 'spotify:track:1234567890ABCDEF', 'Spotify URI is normalized');
        assert(result.stateAt42?.duration === 180, 'Spotify progress milliseconds become seconds');
        assert(result.calls.seek.includes(61), 'Spotify seek receives seconds, not milliseconds');
        assert(result.pausedResumeUsed, 'paused Spotify fallback resumes the current entity instead of restarting it');
        assert(result.nextLoadUsedPlay, 'a newly loaded Spotify queue item still starts with play instead of inheriting resume state');
        assert(result.endedCount === 2, 'each Spotify queue track emits Ended exactly once across real terminal state shapes');
        assert(result.firstEndedItemId === 'spotify-track', 'rewind-to-zero completion ends the first Spotify queue item');
        assert(result.reusedController, 'back-to-back Spotify tracks reuse the proven embed controller');
        assert(result.secondEndedItemId === 'spotify-track-two', 'near-end paused completion ends the current reused Spotify queue item');
        assert(result.mainCardTransportOnly, 'main-card play keeps the Spotify SDK in compact transport mode');
        assert(result.compactTransportHidden, 'main-card play keeps its invisible Spotify transport rendered in the viewport');
        assert(result.internalExpanded, 'Internal Player expands the existing Spotify controller');
        assert(result.closePreservedTransport && result.activeAfterHide, 'closing Internal Player preserves playback ownership');
        assert(result.resumedFromMainCard, 'main-card play can load the requested Spotify entity after Internal Player closes');
        assert(result.calls.destroy === 1, 'stopping destroys the provider controller exactly once');
        assert(result.runtimeError.includes('direct click'), 'runtime provider failure explains the browser interaction requirement');
        assert(result.runtimeErrorVisible === false, 'recoverable provider failure keeps the official control visible');
        assert(result.stalledStatus.includes('direct click'), 'ready-but-stalled playback times out with an actionable message');
        assert(result.stalledTransportVisible, 'blocked autoplay reveals the official Spotify control for recovery');
        assert(result.stalledState.paused === true, 'ready-but-stalled playback returns to paused state');
        assert(result.stalledErrorCount === 1, 'startup watchdog emits one error without retrying or advancing');
        assert(result.volumeBar.includes('localhost'), 'file mode explains that Spotify volume control is available on localhost');
        assert(result.volumeWhilePlaying.spotifyActive && result.volumeWhilePlaying.volume === 0.7,
            'the active official Spotify embed hands its saved volume to the localhost gain path');
        assert(result.volumeAfterStop.spotifyActive === false && result.volumeAfterStop.gain === 1,
            'stopping Spotify returns the shared tab gain to unity');
        assert(result.spotifyNeedsResolution === false, 'Spotify track URLs bypass raw-audio resolution');
        console.log('AUDIOFLIX_SPOTIFY_PLAYBACK_SMOKE_OK');
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
