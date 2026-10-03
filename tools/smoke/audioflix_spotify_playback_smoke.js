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
    const fixture = path.join(os.tmpdir(), `eveos-spotify-playback-${process.pid}.html`);
    const scripts = [
        'audioflix.audio.source.js',
        'audioflix.audio.internal.js',
        'audioflix.audio.url.loaders.js',
        'audioflix.audio.url.widgets.js',
        'audioflix.audio.url.providers.js',
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
                        uri: options.uri, play: 0, resume: 0, pause: 0, seek: [], destroy: 0, loaded: [], controllers: (window.__spotifyControllers || 0) + 1
                    };
                    window.__spotifyControllers = calls.controllers;
                    var controller = window.__spotifyController = {
                        addListener: function (name, listener) { listeners[name] = listener; },
                        play: function () { calls.play += 1; },
                        resume: function () { calls.resume += 1; },
                        pause: function () { calls.pause += 1; },
                        seek: function (seconds) { calls.seek.push(seconds); },
                        loadEntity: function (uri) { calls.loaded.push(uri); },
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
            const progress = [];
            const player = window.EveAudioflixUrlPlayback.createController({
                onPlayback: (detail) => events.push(detail.status),
                onProgress: (detail) => progress.push(detail)
            });
            const item = {
                id: 'spotify-track',
                title: 'Mobius',
                url: 'https://open.spotify.com/track/1234567890ABCDEF',
                volume: 0.7
            };
            await player.play(item);
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
            await player.play(item);
            window.__spotifyController.emit('playback_update', {
                position: 180000,
                duration: 180000,
                isPaused: true
            });
            window.__spotifyController.emit('playback_update', {
                position: 180000,
                duration: 180000,
                isPaused: true
            });
            const nextItem = {
                id: 'spotify-track-two',
                title: 'Next Spotify Track',
                url: 'https://open.spotify.com/track/ABCDEF1234567890',
                volume: 0.6
            };
            await player.play(nextItem);
            const reusedController = window.__spotifyControllers === 1
                && window.__spotifyCalls.loaded.includes('spotify:track:ABCDEF1234567890');
            player.hideInternalView();
            const closePreservedTransport = stage?.hidden === false
                && stage.classList.contains('is-transport-only') === true
                && player.isInternalViewOpen() === false;
            const activeAfterHide = player.isActive();
            await player.play(item);
            const resumedFromMainCard = window.__spotifyCalls.play >= 3;
            await player.stop();
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
                calls: firstCalls,
                stateAt42: progress.find((entry) => entry.currentTime === 42),
                endedCount: events.filter((status) => status === 'Ended').length,
                mainCardTransportOnly,
                compactTransportHidden,
                internalExpanded,
                closePreservedTransport,
                activeAfterHide,
                resumedFromMainCard,
                runtimeError,
                runtimeErrorVisible,
                stalledStatus,
                stalledTransportVisible,
                stalledState,
                stalledErrorCount,
                reusedController,
                spotifyNeedsResolution: window.EveAudioflixAudioSource.needsResolution(item.url)
            };
        });

        assert(result.calls.uri === 'spotify:track:1234567890ABCDEF', 'Spotify URI is normalized');
        assert(result.stateAt42?.duration === 180, 'Spotify progress milliseconds become seconds');
        assert(result.calls.seek.includes(61), 'Spotify seek receives seconds, not milliseconds');
        assert(result.endedCount === 1, 'repeated terminal updates emit Ended once');
        assert(result.reusedController, 'back-to-back Spotify tracks reuse the proven embed controller');
        assert(result.mainCardTransportOnly, 'main-card play keeps the Spotify SDK in compact transport mode');
        assert(result.compactTransportHidden, 'main-card play keeps its invisible Spotify transport rendered in the viewport');
        assert(result.internalExpanded, 'Internal Player expands the existing Spotify controller');
        assert(result.closePreservedTransport && result.activeAfterHide, 'closing Internal Player preserves playback ownership');
        assert(result.resumedFromMainCard, 'main-card play resumes the existing Spotify controller after Internal Player closes');
        assert(result.calls.destroy === 1, 'stopping destroys the provider controller exactly once');
        assert(result.runtimeError.includes('direct click'), 'runtime provider failure explains the browser interaction requirement');
        assert(result.runtimeErrorVisible === false, 'recoverable provider failure keeps the official control visible');
        assert(result.stalledStatus.includes('direct click'), 'ready-but-stalled playback times out with an actionable message');
        assert(result.stalledTransportVisible, 'blocked autoplay reveals the official Spotify control for recovery');
        assert(result.stalledState.paused === true, 'ready-but-stalled playback returns to paused state');
        assert(result.stalledErrorCount === 1, 'startup watchdog emits one error without retrying or advancing');
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
