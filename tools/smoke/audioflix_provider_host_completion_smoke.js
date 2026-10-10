'use strict';
// Lane 2b: provider-host (localhost YouTube bridge) completion. One iframe/token is reused across
// queue entries (loadVideoById) and across repeat-one restarts, so a raw `state=ended` carries no
// identity of its own. Queue completion must come only from canonical Audioflix Ended, and a late
// raw `ended` from a finished era must cause neither a repeat nor an advance.
// Real modules: audio.internal (bridge), audio.url (controller), queue.completion (coordinator),
// transport.resilience (fallback). Mocked: the provider host iframe and its postMessage traffic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const MOD = name => 'file:///' + path.join(ROOT, 'js', 'modules', 'features', 'audioflix', name).replace(/\\/g, '/');
const MODULES = ['audioflix.paths.js', 'audioflix.audio.local.js', 'audioflix.audio.internal.js', 'audioflix.audio.url.loaders.js',
    'audioflix.audio.url.widgets.js', 'audioflix.audio.url.providers.js', 'audioflix.audio.url.direct.js', 'audioflix.audio.url.js',
    'audioflix.queue.completion.js', 'audioflix.transport.resilience.js'];

function assert(condition, message) { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); }

async function main() {
    const fixture = path.join(os.tmpdir(), `eveos-provider-host-completion-${process.pid}.html`);
    fs.writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"></head><body>${
        MODULES.map(name => `<script src="${MOD(name)}"></script>`).join('')}</body></html>`);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/server/audioflix-provider-host.html*', route => route.fulfill({
        status: 200, contentType: 'text/html', body: '<!doctype html><title>Mock provider host</title>' }));
    await page.addInitScript(() => {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => String(url).includes('/server/audioflix-provider-host.html')
            ? new Response('<meta name="eve-audioflix-provider-host" content="1">', { status: 200 })
            : nativeFetch(url, options);
        window.EveAudioflixNative = { getStatus: () => ({ ok: false }) };
    });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    try {
        await page.goto('file:///' + fixture.replace(/\\/g, '/'), { waitUntil: 'load' });
        const result = await page.evaluate(async () => {
            const tick = () => new Promise(resolve => setTimeout(resolve, 30));
            const items = [
                { id: 'yt-a', title: 'A', url: 'https://youtu.be/AAAAAAAAAAA', volume: 1 },
                { id: 'yt-b', title: 'B', url: 'https://youtu.be/BBBBBBBBBBB', volume: 1 },
                { id: 'yt-c', title: 'C', url: 'https://youtu.be/CCCCCCCCCCC', volume: 1 }
            ];
            const counts = { repeat: 0, advance: 0, canonicalEnded: 0 };
            const q = { index: 0, run: 1, isPlaying: true, repeatOne: false };
            const controller = window.EveAudioflixUrlPlayback.createController({
                onPlayback(detail) {
                    if (detail.status === 'Ended') counts.canonicalEnded += 1;
                    window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail }));
                },
                onProgress() {}, onPlayer() {}
            });
            window.EveAudioflixAudio = { getPlaybackState: () => controller.getPlaybackState() };
            const step = async delta => {
                counts.advance += 1;
                q.run += 1;
                if (q.index + delta >= items.length) { q.isPlaying = false; return false; }
                q.index += delta;
                return controller.openInternalView(items[q.index]);
            };
            const restart = async () => {
                counts.repeat += 1;
                q.run += 1;
                await controller.seek(0);
                return controller.openInternalView(items[q.index]);
            };
            window.EveAudioflix = { queueConnection: {
                snapshot: () => ({ isPlaying: q.isPlaying, currentIndex: q.index, playbackRunId: q.run, repeatOne: q.repeatOne,
                    entries: items.map(item => ({ id: item.id, title: item.title })) }),
                step, action: id => (id === 'restart' ? restart() : false)
            } };
            const complete = window.EveAudioflixQueueCompletion.create({
                snapshot: () => window.EveAudioflix.queueConnection.snapshot(), advance: () => step(1), restart });
            window.addEventListener('eve:audioflix-playback', event => complete(event.detail));

            const frame = () => document.querySelector('.audioflix-provider-stage iframe[src*="audioflix-provider-host.html"]');
            const host = (event, extra = {}) => {
                const iframe = frame(), url = new URL(iframe.src);
                window.dispatchEvent(new MessageEvent('message', { origin: url.origin, source: iframe.contentWindow,
                    data: { type: 'eve-audioflix-provider', token: url.searchParams.get('token'), event, currentTime: 0, duration: 200, ...extra } }));
            };
            const state = async name => { host('state', { state: name }); await tick(); await tick(); };
            const snap = label => ({ label, ...counts, index: q.index, run: q.run, isPlaying: q.isPlaying,
                item: controller.getPlaybackState().item?.id, token: new URL(frame().src).searchParams.get('token') });
            const log = [];

            const starting = controller.openInternalView(items[0]);
            for (let i = 0; i < 40 && !frame(); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
            host('ready');
            await starting;
            const token = new URL(frame().src).searchParams.get('token');
            await state('playing');
            // 2. Genuine current provider completion: bridge -> canonical Ended -> one advance.
            await state('ended');
            log.push(snap('A ended (current)'));
            // 3. Same iframe/token A -> B via loadVideoById; a fresh late raw A `ended` before B plays.
            await state('ended');
            log.push(snap('late raw A ended after B load'));
            await state('playing');
            await state('ended');
            log.push(snap('B ended (current)'));
            // 1. Repeat-one: canonical Ended for run N restarts once; a fresh raw `ended` from the
            // same iframe/token before the restarted playback reports Playing does nothing.
            await state('playing');
            q.repeatOne = true;
            await state('ended');
            log.push(snap('C ended with repeat-one'));
            await state('ended');
            log.push(snap('late raw C ended after restart'));
            await state('playing');
            await state('ended');
            log.push(snap('C ended again with repeat-one'));
            q.repeatOne = false;
            await state('playing');
            await state('ended');
            log.push(snap('C ended with repeat off'));
            return { log, token, sameToken: log.every(entry => entry.token === token) };
        });
        const at = label => result.log.find(entry => entry.label === label);
        assert(result.sameToken, 'one provider-host iframe/token is reused for A, B, C and every restart');
        let s = at('A ended (current)');
        assert(s.advance === 1 && s.repeat === 0 && s.index === 1 && s.item === 'yt-b', `current A Ended advances once to B: ${JSON.stringify(s)}`);
        s = at('late raw A ended after B load');
        assert(s.advance === 1 && s.repeat === 0 && s.index === 1 && s.canonicalEnded === 1, `late raw A ended does nothing: ${JSON.stringify(s)}`);
        s = at('B ended (current)');
        assert(s.advance === 2 && s.index === 2 && s.item === 'yt-c', `canonical B Ended advances exactly once: ${JSON.stringify(s)}`);
        s = at('C ended with repeat-one');
        assert(s.repeat === 1 && s.advance === 2 && s.index === 2, `repeat-one restarts once: ${JSON.stringify(s)}`);
        s = at('late raw C ended after restart');
        assert(s.repeat === 1 && s.advance === 2, `late raw ended after restart neither repeats nor advances: ${JSON.stringify(s)}`);
        s = at('C ended again with repeat-one');
        assert(s.repeat === 2 && s.advance === 2, `a genuine Ended of the restarted run repeats once: ${JSON.stringify(s)}`);
        s = at('C ended with repeat off');
        assert(s.repeat === 2 && s.advance === 3 && s.isPlaying === false, `repeat off: the last entry completes once: ${JSON.stringify(s)}`);
        assert(pageErrors.length === 0, `no page errors: ${pageErrors.join(' | ')}`);
        console.log(`AUDIOFLIX_PROVIDER_HOST_COMPLETION_SMOKE_OK ${JSON.stringify(result.log.map(({ label, repeat, advance }) => ({ label, repeat, advance })))}`);
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }
}

main().catch(error => {
    console.error(`AUDIOFLIX_PROVIDER_HOST_COMPLETION_SMOKE_FAIL ${error.message}`);
    process.exitCode = 1;
});
