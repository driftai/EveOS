const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PATHS_MODULE_PATH = path.join(REPO_ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.paths.js');
const LOCAL_MODULE_PATH = path.join(REPO_ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.local.js');
const INTERNAL_MODULE_PATH = path.join(REPO_ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.internal.js');
const LOADERS_MODULE_PATH = path.join(REPO_ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.url.loaders.js');
const WIDGETS_MODULE_PATH = path.join(REPO_ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.url.widgets.js');
const PROVIDERS_MODULE_PATH = path.join(REPO_ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.url.providers.js');
const MODULE_PATH = path.join(REPO_ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.url.js');
const STYLE_PATH = path.join(REPO_ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.provider.css');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function main() {
    const fixture = path.join(os.tmpdir(), `eveos-audioflix-url-${process.pid}.html`);
    const pathsModuleUrl = 'file:///' + PATHS_MODULE_PATH.replace(/\\/g, '/');
    const localModuleUrl = 'file:///' + LOCAL_MODULE_PATH.replace(/\\/g, '/');
    const internalModuleUrl = 'file:///' + INTERNAL_MODULE_PATH.replace(/\\/g, '/');
    const loadersModuleUrl = 'file:///' + LOADERS_MODULE_PATH.replace(/\\/g, '/');
    const widgetsModuleUrl = 'file:///' + WIDGETS_MODULE_PATH.replace(/\\/g, '/');
    const providersModuleUrl = 'file:///' + PROVIDERS_MODULE_PATH.replace(/\\/g, '/');
    const moduleUrl = 'file:///' + MODULE_PATH.replace(/\\/g, '/');
    const styleUrl = 'file:///' + STYLE_PATH.replace(/\\/g, '/');
    fs.writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${styleUrl}"></head><body><script src="${pathsModuleUrl}"></script><script src="${localModuleUrl}"></script><script src="${internalModuleUrl}"></script><script src="${loadersModuleUrl}"></script><script src="${widgetsModuleUrl}"></script><script src="${providersModuleUrl}"></script><script src="${moduleUrl}"></script></body></html>`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/server/audioflix-provider-host.html*', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Mock EveOS provider host</title>'
    }));
    await page.addInitScript(() => {
        window.__providerHostOnline = false;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => {
            if (String(url).includes('/server/audioflix-provider-host.html')) {
                if (!window.__providerHostOnline) throw new TypeError('Provider host offline');
                return new Response('<meta name="eve-audioflix-provider-host" content="1">', { status: 200 });
            }
            return nativeFetch(url, options);
        };
        window.__fakeAudioInstances = [];
        class FakeAudio extends EventTarget {
            constructor() {
                super();
                this.currentTime = 0;
                this.duration = 180;
                this.paused = true;
                this.volume = 1;
                this.src = '';
                window.__fakeAudioInstances.push(this);
            }
            async play() {
                this.paused = false;
                this.dispatchEvent(new Event('play'));
            }
            pause() {
                this.paused = true;
                this.dispatchEvent(new Event('pause'));
            }
            load() { }
            removeAttribute(name) { if (name === 'src') this.src = ''; }
        }
        window.Audio = FakeAudio;
        window.EveAudioflixNative = { getStatus: () => ({ ok: false }) };
    });

    try {
        await page.goto('file:///' + fixture.replace(/\\/g, '/'), { waitUntil: 'load' });
        const result = await page.evaluate(async () => {
            const playbackEvents = [];
            const progressEvents = [];
            const waveformPlayers = [];
            const makeController = () => window.EveAudioflixUrlPlayback.createController({
                onPlayback: (detail) => playbackEvents.push(detail),
                onProgress: (detail) => progressEvents.push(detail),
                onPlayer: (player) => waveformPlayers.push(player)
            });

            const direct = makeController();
            const directItem = { id: 'direct-1', title: 'Direct MP3', url: 'https://media.example.test/song.mp3', volume: 0.5 };
            const preferred = direct.shouldPreferBrowser(directItem);
            await direct.play(directItem);
            await direct.seek(42);
            direct.setVolume(0.3);
            const directState = direct.getPlaybackState();
            await direct.pause();
            const directAudio = window.__fakeAudioInstances[0];
            await direct.stop();

            const localDirect = makeController();
            await localDirect.play({ id: 'local-direct', title: 'Local Direct', url: 'blob:audioflix-local' });
            const localDirectAudio = localDirect.getAudioElement();
            await localDirect.stop();

            let youtubePlayerAttempts = 0;
            window.YT = {
                PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2 },
                Player: function (host, options) {
                    youtubePlayerAttempts += 1;
                }
            };
            const youtube = makeController();
            const ytItem = { id: 'yt-1', title: 'YouTube Track', url: 'https://youtu.be/M7lc1UVf-VE', volume: 0.4 };
            let blockedMessage = '';
            try { await youtube.play(ytItem); } catch (error) { blockedMessage = error.message; }
            const blockedStageElement = document.querySelector('.audioflix-provider-stage.has-error');
            const blockedPlayback = youtube.getPlaybackState();
            const normalStageState = {
                exists: !!blockedStageElement,
                hidden: blockedStageElement?.hidden ?? null,
                className: blockedStageElement?.className || '',
                transportOnly: !!blockedStageElement?.classList.contains('is-transport-only'),
                transportHidden: !!blockedStageElement?.classList.contains('is-transport-hidden'),
                internalView: youtube.isInternalViewOpen()
            };
            const normalStageTransportOnly = normalStageState.exists
                && normalStageState.hidden === false
                && normalStageState.transportOnly
                && normalStageState.internalView === false;
            const blockedActive = youtube.isActive();
            const blockedStage = blockedStageElement?.textContent || '';
            const blockedFrameDisplay = getComputedStyle(blockedStageElement.querySelector('.audioflix-provider-frame')).display;
            const blockedStageHeight = blockedStageElement.getBoundingClientRect().height;
            await youtube.stop();

            window.__providerHostOnline = true;
            const internalYouTube = makeController();
            const internalPending = internalYouTube.openInternalView(ytItem);
            let internalFrame = null;
            for (let attempt = 0; attempt < 40 && !internalFrame; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                internalFrame = document.querySelector('.audioflix-provider-stage iframe[src*="audioflix-provider-host.html"]');
            }
            if (!internalFrame) throw new Error('localhost provider iframe was not created');
            const bridgeUrl = new URL(internalFrame.src);
            const bridgeToken = bridgeUrl.searchParams.get('token');
            window.dispatchEvent(new MessageEvent('message', {
                origin: bridgeUrl.origin,
                source: internalFrame.contentWindow,
                data: { type: 'eve-audioflix-provider', token: bridgeToken, event: 'ready', currentTime: 0, duration: 212 }
            }));
            await internalPending;
            window.dispatchEvent(new MessageEvent('message', {
                origin: bridgeUrl.origin,
                source: internalFrame.contentWindow,
                data: { type: 'eve-audioflix-provider', token: bridgeToken, event: 'state', state: 'playing' }
            }));
            window.dispatchEvent(new MessageEvent('message', {
                origin: bridgeUrl.origin,
                source: internalFrame.contentWindow,
                data: { type: 'eve-audioflix-provider', token: bridgeToken, event: 'progress', currentTime: 37, duration: 212 }
            }));
            const internalState = internalYouTube.getPlaybackState();
            const internalStage = internalFrame.closest('.audioflix-provider-stage');
            const internalExpanded = internalStage.classList.contains('is-internal-view');
            const internalVisible = internalStage.hidden === false;
            const internalHeader = internalStage.querySelector('header span').textContent;
            const internalFrameTitle = internalFrame.title;
            const internalStatus = internalStage.querySelector('.audioflix-provider-status').textContent;
            const internalSource = internalStage.querySelector('header a').href;
            const internalFrameUrl = internalFrame.src;
            await internalYouTube.stop();

            const soundCloudPlayers = [];
            const SoundCloudWidget = function () {
                const handlers = {};
                const player = {
                    volume: 100,
                    bind(name, callback) {
                        handlers[name] = callback;
                        if (name === 'ready') setTimeout(callback, 0);
                    },
                    setVolume(value) { this.volume = value; },
                    getDuration(callback) { callback(90000); },
                    play() { handlers.play?.(); },
                    pause() { handlers.pause?.(); },
                    seekTo(value) { handlers.progress?.({ currentPosition: value }); }
                };
                soundCloudPlayers.push(player);
                return player;
            };
            SoundCloudWidget.Events = { READY: 'ready', PLAY: 'play', PAUSE: 'pause', FINISH: 'finish', PLAY_PROGRESS: 'progress' };
            window.SC = { Widget: SoundCloudWidget };
            const soundCloud = makeController();
            const scItem = { id: 'sc-1', title: 'SoundCloud Track', url: 'https://soundcloud.com/example/track', volume: 0.6 };
            await soundCloud.play(scItem);
            await soundCloud.seek(31);
            soundCloud.setVolume(0.2);
            const scState = soundCloud.getPlaybackState();
            const scVolume = soundCloudPlayers[0].volume;
            await soundCloud.stop();

            class VimeoPlayer {
                constructor() { this.handlers = {}; this.volume = 1; this.time = 0; }
                on(name, callback) { this.handlers[name] = callback; }
                async ready() { }
                async play() { this.handlers.play?.(); }
                async pause() { this.handlers.pause?.(); }
                async setVolume(value) { this.volume = value; }
                async setCurrentTime(value) { this.time = value; this.handlers.timeupdate?.({ seconds: value, duration: 150 }); }
                async destroy() { this.destroyed = true; }
            }
            window.Vimeo = { Player: VimeoPlayer };
            const vimeo = makeController();
            const vimeoItem = { id: 'vimeo-1', title: 'Vimeo Track', url: 'https://vimeo.com/76979871', volume: 0.7 };
            await vimeo.play(vimeoItem);
            await vimeo.seek(19);
            vimeo.setVolume(0.35);
            const vimeoState = vimeo.getPlaybackState();
            const vimeoVolume = vimeoState.item.volume;
            await vimeo.stop();

            const localAttempts = [];
            window.EveAudioflixFsPorts = {
                fileUrlForPath: async (localPath) => {
                    localAttempts.push(localPath);
                    return /Preferred[/\\]Song\.mp3$/i.test(localPath) ? 'blob:preferred-local-copy' : '';
                }
            };
            let nativeProbeCalls = 0;
            window.EveAudioflixNative = {
                getLocalFileUrl: (localPath) => `http://127.0.0.1:8765/local?path=${encodeURIComponent(localPath)}`,
                probeLocalFile: async () => {
                    nativeProbeCalls += 1;
                    return false;
                }
            };
            const dualSourceItem = {
                id: 'dual',
                title: 'Dual Source',
                url: 'https://youtu.be/M7lc1UVf-VE',
                localPath: 'C:/Legacy/Song.mp3',
                localizations: [
                    { source: 'group:Later', path: 'C:/Group/Song.mp3', kind: 'file' },
                    { source: 'folder:Preferred', path: 'C:/Preferred/Song.mp3', kind: 'file' }
                ]
            };
            const localPrepared = await window.EveAudioflixLocalPlayback.prepare(dualSourceItem);
            window.EveAudioflixFsPorts.fileUrlForPath = async () => '';
            const fallbackPrepared = await window.EveAudioflixLocalPlayback.prepare(dualSourceItem);
            window.EveAudioflixFsPorts.fileUrlForPath = async (localPath) => (
                /Legacy[/\\]Standalone\.mp3$/i.test(localPath) ? 'blob:legacy-local-copy' : ''
            );
            const legacyPrepared = await window.EveAudioflixLocalPlayback.prepare({
                id: 'legacy-local',
                title: 'Legacy Local',
                url: 'C:/Legacy/Standalone.mp3'
            });

            const releasedLocalUrls = [];
            const resourcePlayer = new Audio();
            let resourceLoads = 0;
            resourcePlayer.load = () => { resourceLoads += 1; };
            resourcePlayer.src = 'blob:old-local-track';
            window.EveAudioflixFsPorts.releaseFileUrl = (url) => releasedLocalUrls.push(url);
            window.EveAudioflixLocalPlayback.setMediaSource(resourcePlayer, 'blob:new-local-track');
            const sourceAfterSwap = resourcePlayer.src;
            window.EveAudioflixLocalPlayback.clearMediaSource(resourcePlayer);

            return {
                preferred,
                providerDirect: window.EveAudioflixUrlPlayback.providerFor(directItem.url),
                providerYouTube: window.EveAudioflixUrlPlayback.providerFor(ytItem.url),
                youtubeId: window.EveAudioflixUrlPlayback.youtubeId(ytItem.url),
                directState,
                directPaused: directAudio.paused,
                directVolume: directAudio.volume,
                directCrossOrigin: directAudio.crossOrigin,
                remoteDirectWaveformSafe: directAudio._eveAudioflixWaveformSafe,
                localDirectWaveformSafe: localDirectAudio?._eveAudioflixWaveformSafe,
                localDirectWaveformAttached: waveformPlayers.includes(localDirectAudio),
                playbackEvents: playbackEvents.map((event) => event.status),
                progressCount: progressEvents.length,
                youtubePlayerAttempts,
                blockedItemTitle: blockedPlayback.item?.title || '',
                normalStageState,
                normalStageTransportOnly,
                scState,
                scVolume,
                vimeoState,
                vimeoVolume,
                blockedMessage,
                blockedActive,
                blockedStage,
                blockedFrameDisplay,
                blockedStageHeight,
                internalState,
                internalExpanded,
                internalVisible,
                internalHeader,
                internalFrameTitle,
                internalStatus,
                internalSource,
                internalFrameUrl,
                localAttempts,
                localPreparedUrl: localPrepared.item.url,
                localPreparedPath: localPrepared.localPath,
                fallbackPreparedUrl: fallbackPrepared.item.url,
                fallbackStatus: fallbackPrepared.status,
                legacyPreparedUrl: legacyPrepared.item.url,
                nativeProbeCalls,
                releasedLocalUrls,
                resourceLoads,
                sourceAfterSwap,
                sourceAfterClear: resourcePlayer.src
            };
        });

        assert(result.preferred, 'file:// remote tracks should prefer browser-only playback while the bridge is offline');
        assert(result.providerDirect === 'direct', `wrong direct provider: ${result.providerDirect}`);
        assert(result.providerYouTube === 'youtube', `wrong YouTube provider: ${result.providerYouTube}`);
        assert(result.youtubeId === 'M7lc1UVf-VE', `wrong YouTube id: ${result.youtubeId}`);
        assert(result.directState.currentTime === 42 && result.directState.duration === 180, 'direct media seek/duration state failed');
        assert(result.directPaused && result.directVolume === 0.3, 'direct media pause/volume controls failed');
        assert(result.directCrossOrigin == null, 'browser-only direct media must not force CORS mode');
        assert(result.remoteDirectWaveformSafe === false, 'cross-origin direct media was incorrectly attached to Web Audio');
        assert(result.localDirectWaveformSafe === true && result.localDirectWaveformAttached, 'local internal media did not attach to the routing waveform');
        assert(result.playbackEvents.some((status) => /directly from the browser/.test(status)), 'direct playback status missing');
        assert(result.progressCount > 0, 'direct playback progress events missing');
        assert(result.blockedItemTitle === 'YouTube Track', `failed provider playback state lost the attempted track: ${result.blockedItemTitle}`);
        assert(result.normalStageTransportOnly, `failed YouTube provider fallback was not isolated to its transport stage: ${JSON.stringify(result.normalStageState)}`);
        assert(result.scState.provider === 'soundcloud' && result.scState.currentTime === 31, 'SoundCloud transport state failed');
        assert(result.scVolume === 20, `SoundCloud volume was not forwarded: ${result.scVolume}`);
        assert(result.vimeoState.provider === 'vimeo' && result.vimeoState.currentTime === 19, 'Vimeo transport state failed');
        assert(result.vimeoVolume === 0.35, `Vimeo volume was not forwarded: ${result.vimeoVolume}`);
        assert(/HTTPS\/app identity/.test(result.blockedMessage), 'YouTube file:// error 153 did not explain the provider restriction');
        assert(result.blockedActive === false, 'failed provider remained active');
        assert(result.youtubePlayerAttempts === 0, 'file:// playback should not create a YouTube iframe that is guaranteed to fail');
        assert(/direct media URL/.test(result.blockedStage), 'provider error UI did not offer a usable fallback');
        assert(result.blockedFrameDisplay === 'none', 'blocked provider frame should collapse instead of leaving a black box');
        assert(result.blockedStageHeight <= 184, `off-screen provider fallback exceeded its transport shell: ${result.blockedStageHeight}px`);
        assert(result.internalExpanded, 'explicit Internal View did not expand the provider surface');
        assert(result.internalVisible, 'explicit Internal View remained hidden');
        assert(result.internalHeader === 'Internal player', `provider-specific Internal player title leaked: ${result.internalHeader}`);
        assert(/Internal player$/.test(result.internalFrameTitle), `provider iframe title was not generic: ${result.internalFrameTitle}`);
        assert(result.internalState.currentTime === 37 && result.internalState.duration === 212 && result.internalState.paused === false, 'localhost provider bridge did not relay playback state');
        assert(/inside EveOS/.test(result.internalStatus), `internal player status missing: ${result.internalStatus}`);
        assert(result.internalSource === 'https://youtu.be/M7lc1UVf-VE', `internal player source fallback changed: ${result.internalSource}`);
        assert(/^http:\/\/127\.0\.0\.1:8765\/server\/audioflix-provider-host\.html\?/.test(result.internalFrameUrl), `wrong provider host URL: ${result.internalFrameUrl}`);
        assert(result.localPreparedUrl === 'blob:preferred-local-copy', 'dual-source playback did not choose the local file first');
        assert(/Preferred[/\\]Song\.mp3$/i.test(result.localPreparedPath), 'folder localization was not the preferred local source');
        assert(result.localAttempts.length === 1 && /Preferred[/\\]Song\.mp3$/i.test(result.localAttempts[0]), 'lower-priority paths were tried before the preferred folder copy');
        assert(result.fallbackPreparedUrl === 'https://youtu.be/M7lc1UVf-VE', 'unreachable local files did not fall back to the online URL');
        assert(/streaming instead/.test(result.fallbackStatus), 'local-to-online fallback did not explain its route');
        assert(result.legacyPreparedUrl === 'blob:legacy-local-copy', 'legacy absolute URL paths bypassed the local resolver');
        assert(result.nativeProbeCalls >= 1, 'localhost local-file candidates were not verified before fallback');
        assert(result.sourceAfterSwap === 'blob:new-local-track', 'track source swap did not install the next local URL');
        assert(result.sourceAfterClear === '' && result.resourceLoads === 2,
            'completed/stopped local media did not unload its decoder resource');
        assert(result.releasedLocalUrls.join('|') === 'blob:old-local-track|blob:new-local-track',
            `local blob URLs were retained after source handoff: ${result.releasedLocalUrls.join('|')}`);
        console.log('AUDIOFLIX_FILE_URL_PLAYBACK_SMOKE_OK');
    } finally {
        await browser.close();
        try { fs.unlinkSync(fixture); } catch { }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
