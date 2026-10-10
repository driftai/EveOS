const path = require('path');
const { launchChromiumOrConnect, waitForEveCoreHydrated } = require('./playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE_URL = 'file:///' + path.join(ROOT, 'EveOS.html').replace(/\\/g, '/');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function verifyReusedProviderHeading(browser) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    try {
        // Isolated page: no EveOS boot, persisted library, localhost, or provider requests.
        await page.setContent('<button id="reopen">Reopen player</button>');
        for (const file of ['audioflix.audio.internal.js', 'audioflix.audio.url.providers.js']) {
            await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix', file) });
        }
        await page.evaluate(() => {
            window.__headingFixture = { creations: 0, loads: 0 };
            window.EveAudioflixUrlLoaders = {};
            window.EveAudioflixUrlDirect = { create: () => () => {} };
            window.EveAudioflixUrlWidgets = { create: () => ({}) };
            window.EveAudioflixSpotifyPlayback = { create: (ctx) => ({
                playSpotify: async (item) => {
                    window.__headingFixture.creations += 1;
                    const mirror = document.createElement('div');
                    mirror.id = 'synthetic-provider-mirror';
                    ctx.ensureStage(item, 'Spotify').appendChild(mirror);
                    const player = {
                        play: async () => {
                            ctx.view.playback.paused = false;
                            mirror.textContent = ctx.view.playback.item.title;
                            ctx.emitProgress();
                        },
                        loadItem: async () => { window.__headingFixture.loads += 1; await player.play(); },
                        setVolume() {}, destroy() {}
                    };
                    ctx.view.active = { kind: 'spotify', player };
                    await player.play();
                }
            }) };
        });
        await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.audio.url.js') });
        await page.evaluate(async () => {
            const tracks = ['Young Girl A', '16', 'Next track'].map((title, index) => ({
                id: String(index), title, url: `https://open.spotify.com/track/fixture${index}`, volume: 0.5
            }));
            let index = 0;
            const select = async (next) => {
                index = next;
                await player.openInternalView(tracks[index]);
                player.setQueue(tracks, index);
            };
            const player = window.EveAudioflixUrlPlayback.createController({
                onJump: select, onStep: (delta) => select(index + delta)
            });
            window.__headingFixture.player = player;
            document.querySelector('#reopen').onclick = () => select(index);
            await select(0);
        });
        const stage = page.locator('.audioflix-provider-stage');
        const title = stage.locator('header strong');
        assert(await title.textContent() === 'Young Girl A', 'initial provider heading');
        const target = stage.locator('[data-queue-index="1"]');
        const box = await target.boundingBox();
        assert(box?.width > 0 && box?.height > 0, 'queue heading regression target has visible geometry');
        await target.click();
        await page.waitForFunction(() => window.__headingFixture.player.getPlaybackState().item.title === '16');
        assert(await page.locator('#synthetic-provider-mirror').textContent() === '16', 'provider mirror switched tracks');
        assert((await stage.locator('li.is-current [data-url-player-action="queue-jump"]').textContent()).includes('16'),
            'queue highlight switched tracks');
        assert(await title.textContent() === '16', `reused provider heading is stale: ${await title.textContent()}`);
        assert(await stage.locator('header a').getAttribute('href') === 'https://open.spotify.com/track/fixture1',
            'reused provider source link follows the active track');
        await stage.locator('[data-url-player-action="next"]').click();
        await page.waitForFunction(() => document.querySelector('.audioflix-provider-stage header strong').textContent === 'Next track');
        await stage.locator('[data-url-player-action="collapse"]').click();
        await stage.locator('[data-url-player-action="prev"]').click();
        await page.waitForFunction(() => document.querySelector('.audioflix-provider-stage header strong').textContent === '16');
        await stage.locator('[data-url-player-action="stop"]').click();
        await page.locator('#reopen').click();
        assert(await title.textContent() === '16', 'reopening retains the active heading');
        const reuse = await page.evaluate(() => ({ creations: window.__headingFixture.creations,
            loads: window.__headingFixture.loads, mirrors: document.querySelectorAll('#synthetic-provider-mirror').length }));
        assert(reuse.creations === 1 && reuse.loads === 3 && reuse.mirrors === 1,
            'heading updates retain one provider controller and embedded mirror');
        assert(errors.length === 0, `heading regression page errors: ${errors.join(' | ')}`);
    } finally {
        await page.close();
    }
}

(async () => {
    const { browser } = await launchChromiumOrConnect({ headless: true });
    try {
    await verifyReusedProviderHeading(browser);
    if (process.argv.includes('--heading-only')) {
        console.log('AUDIOFLIX_INTERNAL_HEADING_SMOKE_OK');
        return;
    }
    const page = await browser.newPage();
    await page.addInitScript(() => {
        try { localStorage.clear(); } catch { }
        window.__eveSmokeNoAutoGemini = true;
    });
    await page.goto(FILE_URL, { waitUntil: 'load', timeout: 180000 });
    await waitForEveCoreHydrated(page);
    await page.waitForFunction(() => !!(
        window.EveAudioflixAudio?.openInternalView
        && window.EveAudioflixAudioSource?.resolveItem
        && window.EveAudioflixUrlPlayback?.createController
    ), undefined, { timeout: 60000 });

    const result = await page.evaluate(async () => {
        const fakePlayers = [];
        class FakeAudio extends EventTarget {
            constructor() {
                super();
                this.currentTime = 0;
                this.duration = 240;
                this.paused = true;
                this.volume = 1;
                this.src = '';
                // A real HTMLAudioElement always has these; the waveform controller reads them.
                this.dataset = {};
                this.crossOrigin = null;
                fakePlayers.push(this);
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
            async setSinkId(value) { this.sinkId = value; }
        }

        const originalAudio = window.Audio;
        const source = window.EveAudioflixAudioSource;
        const native = window.EveAudioflixNative;
        const originalNeedsResolution = source.needsResolution;
        const originalResolveItem = source.resolveItem;
        const originalGetStatus = native.getStatus;
        const originalSuppress = native.shouldSuppressBrowserPlayback;
        const state = window.EveAudioflixState;
        const originalState = JSON.parse(JSON.stringify(state.ensure()));
        const waveform = window.EveAudioflixAudio.getWaveformController?.();
        const originalWaveformAttach = waveform?.attachPlayer;
        const waveformPlayers = [];
        let resolutions = 0;
        try {
            window.Audio = FakeAudio;
            if (waveform) waveform.attachPlayer = (player) => waveformPlayers.push(player);
            state.update({ preferredSinkId: 'test-output', preferredSinkLabel: 'Test output' }, 'smoke-output');
            source.needsResolution = () => true;
            source.resolveItem = async (item) => {
                resolutions += 1;
                return {
                    ...item,
                    sourceUrl: item.url,
                    url: 'https://media.example.test/resolved-track.m4a',
                    resolvedDuration: 240
                };
            };
            native.getStatus = () => ({ ok: true });
            native.shouldSuppressBrowserPlayback = () => true;

            const item = {
                id: 'resolved-youtube-track',
                type: 'music',
                title: 'Resolved YouTube Track',
                url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
                volume: 0.65
            };
            await window.EveAudioflixAudio.openInternalView(item);
            const stage = document.querySelector('.audioflix-provider-stage:not([hidden])');
            const internal = {
                resolutions,
                provider: stage?.dataset.provider || '',
                sourceHref: stage?.querySelector('header a')?.href || '',
                playerSrc: fakePlayers[0]?.src || '',
                playing: fakePlayers[0]?.paused === false
            };

            await window.EveAudioflixAudio.stopAll();
            native.getStatus = () => ({ ok: false });
            await window.EveAudioflixAudio.playItem(item);
            // The library reuses ONE long-lived media element ("continuous"), so identify the
            // music player by the element actually carrying the resolved track, not by a new
            // object appearing — counting allocations asserted the opposite of the design.
            const musicPlayer = fakePlayers.filter((p) => p.src && !p.paused).pop()
                || fakePlayers[fakePlayers.length - 1];
            return {
                internal,
                internalWaveformAttached: waveformPlayers.includes(fakePlayers[0]),
                totalResolutions: resolutions,
                continuousPlayers: fakePlayers.length,
                musicSrc: musicPlayer?.src || '',
                musicPlaying: musicPlayer?.paused === false,
                musicSink: musicPlayer?.sinkId || '',
                status: window.EveAudioflixAudio.getStatus?.() || {}
            };
        } finally {
            await window.EveAudioflixAudio.stopAll().catch(() => { });
            window.Audio = originalAudio;
            source.needsResolution = originalNeedsResolution;
            source.resolveItem = originalResolveItem;
            native.getStatus = originalGetStatus;
            native.shouldSuppressBrowserPlayback = originalSuppress;
            if (waveform && originalWaveformAttach) waveform.attachPlayer = originalWaveformAttach;
            state.replaceState(originalState, 'smoke-restore');
        }
    });

    assert(result.internal.resolutions === 1, 'internal view did not resolve the platform URL first');
    assert(result.internal.provider.includes('direct'), `internal view used ${result.internal.provider || 'no'} provider instead of resolved direct audio`);
    assert(result.internal.playerSrc.includes('resolved-track.m4a'), 'internal view did not use the resolved audio URL');
    assert(result.internal.sourceHref.includes('youtube.com/watch'), 'internal view lost the original source link');
    assert(result.internal.playing, 'resolved internal audio did not start');
    assert(result.internalWaveformAttached, 'resolved internal audio did not attach to the routing waveform');
    assert(result.totalResolutions === 2, 'file-mode music skipped resolver-first playback while the native probe was cold');
    // One reused element for the whole run, not a fresh one per track.
    assert(result.continuousPlayers <= 2, `music should reuse the continuous media element (saw ${result.continuousPlayers})`);
    assert(result.musicSrc.includes('resolved-track.m4a'), 'music player did not use the resolved URL');
    assert(result.musicPlaying, 'music player did not start');
    assert(result.musicSink === 'test-output', 'continuous music did not preserve the selected browser output');
    assert(result.status.native !== true, 'music incorrectly entered the chunked native PCM route');
    console.log('AUDIOFLIX_INTERNAL_RESOLUTION_SMOKE_OK');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
