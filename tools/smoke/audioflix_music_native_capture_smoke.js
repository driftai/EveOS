// Music -> native EveOS bridge: no play->sound lag, and a STABLE stream (no cut-outs).
//
// The bridge plays from a bounded queue drained by a device callback: an empty queue emits
// silence (audible cut-outs), a full one drops its oldest chunk. Capture runs at exactly 1x
// realtime, so this controller builds a cushion before its first send and then pumps chunks
// strictly in order.
//
// Asserts: (a) the native music route never pre-decodes the track (that was the lag),
// (b) local speakers are silenced while the route owns the audio, (c) nothing is sent until the
// prebuffer cushion is built, (d) once streaming, chunks are sent strictly sequentially (never
// overlapping/out of order), (e) the device stream is pre-warmed so the first chunks aren't
// clipped by a cold open, (f) stop tears the tap down and restores local output.
const path = require('path');
const { launchChromiumOrConnect, waitForEveCoreHydrated } = require('./playwright-browser');
const FILE_URL = 'file:///' + path.join(path.resolve(__dirname, '..', '..'), 'EveOS.html').replace(/\\/g, '/');

(async () => {
    const { browser } = await launchChromiumOrConnect({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
        try { localStorage.clear(); } catch {}
        window.__eveSmokeNoAutoGemini = true;
    });
    await page.goto(FILE_URL, { waitUntil: 'load', timeout: 180000 });
    await waitForEveCoreHydrated(page);
    await page.waitForFunction(() => !!(window.EveAudioflixAudio?.playItem
        && window.EveAudioflixAudioCapture?.ready
        && window.EveAudioflixState?.ready), undefined, { timeout: 60000 });

    const result = await page.evaluate(async () => {
        const RATE = 48000;
        const FRAME = 4096;                       // ~85ms per tap callback
        const settle = () => new Promise((r) => setTimeout(r, 120));
        const out = { decodes: 0, chunks: 0, overlaps: 0, warmed: 0 };

        // Spy the decode path — the native music route must NOT touch it (that was the lag).
        window.EveAudioflixAudioCodec.getDecodedBuffer = async () => {
            out.decodes += 1;
            return { duration: 1, sampleRate: RATE, numberOfChannels: 1, length: RATE, getChannelData: () => new Float32Array(RATE) };
        };

        let inFlight = 0;
        window.EveAudioflixNative.warm = async () => { out.warmed += 1; return true; };
        window.EveAudioflixNative.stopStream = async () => true;
        // The mocked bridge is live; do not let the real offline probe (no native server here) veto sends.
        window.EveAudioflixNative.isBridgeOffline = () => false;
        window.EveAudioflixNative.sendGeminiChunk = async (payload, detail) => {
            // Two concurrent sends would mean chunks can hit the device out of order.
            inFlight += 1;
            if (inFlight > 1) out.overlaps += 1;
            await new Promise((r) => setTimeout(r, 5));
            if (payload && detail?.channels === 1) out.chunks += 1;
            inFlight -= 1;
            return true;
        };

        let tap = null;
        let muted = null;
        let paused = false;
        const capture = window.EveAudioflixAudioCapture.createController({
            getWaveform: () => ({
                setSpeakerMuted: (value) => { muted = value; return true; },
                setFrameTap: (handler) => { tap = handler; return handler ? RATE : 0; }
            }),
            getPlayer: () => ({ paused }),
            getVolume: () => 1
        });

        const frames = (channels) => ({
            numberOfChannels: channels,
            getChannelData: (index) => {
                const data = new Float32Array(FRAME);
                for (let n = 0; n < FRAME; n += 1) data[n] = index === 0 ? 0.5 : -0.25;
                return data;
            }
        });

        // (a)+(b)+(e) Start: no decode, speakers silenced, device pre-warmed.
        out.started = await capture.start();
        out.muted = muted;
        out.decodesAfterStart = out.decodes;

        // (c) Below the cushion (~400ms) nothing should be sent yet.
        tap(frames(2), RATE);
        tap(frames(2), RATE);          // ~170ms buffered
        await settle();
        out.chunksWhilePriming = out.chunks;

        // Cross the cushion, then keep feeding — now it streams.
        for (let i = 0; i < 8; i += 1) tap(frames(2), RATE);
        await settle();
        await settle();
        out.chunksAfterPriming = out.chunks;

        // (f) Stop restores local output and removes the tap.
        capture.stop();
        out.unmutedAfterStop = muted === false;
        out.tapTornDown = tap === null;

        // (g) Bridge armed in saved state but the server is DEAD. shouldSuppressBrowserPlayback()
        // only reads state flags, so we still get here — and committing anyway muted the speakers
        // and streamed PCM into the void: a track that "plays" in total silence. The pre-open is
        // the liveness check, so a definite failure must DECLINE the route and leave local audio
        // alone, letting the caller fall back to browser playback.
        muted = null;
        window.EveAudioflixNative.warm = async () => false;
        out.startedWhileBridgeDown = await capture.start();
        out.mutedWhileBridgeDown = muted;
        out.tapAfterDeclining = tap;

        // A warm() that throws (connection refused) is the same verdict.
        muted = null;
        window.EveAudioflixNative.warm = async () => { throw new Error('Native bridge unreachable'); };
        out.startedWhileBridgeThrows = await capture.start();
        out.mutedWhileBridgeThrows = muted;
        return out;
    });

    await browser.close();
    const fails = [];
    if (!result.started) fails.push('native music capture did not start');
    if (result.decodesAfterStart !== 0) fails.push(`native music route pre-decoded the track (${result.decodesAfterStart} decodes) — that is the play->sound lag`);
    if (result.muted !== true) fails.push('local speakers were not silenced while the native route owns the audio');
    if (!result.warmed) fails.push('device stream was not pre-warmed (first chunks can be clipped by a cold open)');
    if (result.chunksWhilePriming !== 0) fails.push(`streamed before the cushion was built (${result.chunksWhilePriming} chunks) — the device queue would run dry`);
    if (!result.chunksAfterPriming) fails.push('no PCM reached the bridge after the cushion was built');
    if (result.overlaps) fails.push(`${result.overlaps} overlapping sends — chunks can reach the device out of order (choppy audio)`);
    if (!result.unmutedAfterStop) fails.push('local output was not restored after stopping the native route');
    if (!result.tapTornDown) fails.push('live PCM tap was not torn down on stop');
    if (result.startedWhileBridgeDown !== false) fails.push('capture claimed the native route even though the device would not open — audio goes nowhere');
    if (result.mutedWhileBridgeDown === true) fails.push('local speakers were silenced for a native route that never opened (silent playback)');
    if (result.tapAfterDeclining !== null) fails.push('declined native route left its PCM tap attached');
    if (result.startedWhileBridgeThrows !== false) fails.push('capture claimed the native route after the pre-open threw (bridge unreachable)');
    if (result.mutedWhileBridgeThrows === true) fails.push('local speakers were silenced after the pre-open threw (silent playback)');
    if (fails.length) { console.error('FAIL: ' + fails.join('; ')); process.exit(1); }
    console.log(`AUDIOFLIX_MUSIC_NATIVE_CAPTURE_OK (decodes=0, priming=0, chunks=${result.chunksAfterPriming}, overlaps=0)`);
})().catch((e) => { console.error(e); process.exit(1); });
