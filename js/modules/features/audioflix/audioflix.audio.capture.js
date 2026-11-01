// Live PCM capture for the native EveOS route.
//
// Soundboard clips are short enough to decode up front (buffering is also what makes them
// mixable voices). A music track is not: decoding a whole song before the first sample is what
// put a lag between pressing play and hearing sound. This controller instead lets the media
// element play normally (instant start, seekable, progressive) while the LIVE signal is tapped
// from the Web Audio graph and streamed to the native bridge, with local speakers silenced so
// only the routed device hears it ("bypasser").
//
// The bridge mixes mono server-side (play_pcm keeps a single channel), so a stereo track is
// downmixed here rather than silently losing its right channel.
window.EveAudioflixAudioCapture = window.EveAudioflixAudioCapture || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixAudioCapture;
    if (ns.ready) return;

    // The bridge plays from a bounded queue drained by a device callback: an EMPTY queue emits
    // silence (audible cut-outs) and a FULL one drops its oldest chunk. Capture runs at exactly
    // 1x realtime, so sending each chunk the instant it appears leaves the queue hovering at empty
    // and any jitter/GC starves it. So: build a cushion before the first send, then pump chunks
    // strictly in order (never overlapping POSTs, which could also arrive out of sequence).
    const PREBUFFER_MS = 400;
    const MAX_BACKLOG_MS = 2000;
    // Upper bound on waiting for the device pre-open so a slow server can't stall playback.
    const WARM_TIMEOUT_MS = 700;

    ns.createController = function createController(deps) {
        const getWaveform = deps.getWaveform;
        const getPlayer = deps.getPlayer;
        const getVolume = deps.getVolume;
        let active = false;
        let pending = [];
        let pendingMs = 0;
        let rate = 0;
        let priming = true;
        let pumping = false;
        let dropped = 0;
        let streamId = '';
        let activeItemId = '';
        let activeDeviceId = '';
        let pumpPromise = Promise.resolve();
        let stopPromise = null;

        function reset() {
            pending = [];
            pendingMs = 0;
            priming = true;
        }

        function enqueue(mono) {
            pending.push(mono);
            pendingMs += (mono.length / rate) * 1000;
            // Bridge lagging realtime: bound the drift instead of growing delay without limit.
            while (pendingMs > MAX_BACKLOG_MS && pending.length > 1) {
                pendingMs -= (pending.shift().length / rate) * 1000;
                dropped += 1;
            }
        }

        async function send(chunk) {
            if (window.EveAudioflixNative?.isBridgeOffline?.()) return false;
            const payload = window.EveAudioflixAudioBridge?.encodePcm?.(chunk, 0, chunk.length, getVolume());
            if (!payload) return true;
            const detail = { sampleRate: rate, channels: 1, streamId, deviceId: activeDeviceId };
            let ok = await window.EveAudioflixNative?.sendGeminiChunk?.(payload, detail);
            // One retry: a single transient failure would otherwise punch a hole in the audio.
            if (ok !== true) ok = await window.EveAudioflixNative?.sendGeminiChunk?.(payload, detail);
            return ok === true;
        }

        function pump() {
            if (pumping) return pumpPromise;
            pumping = true;
            pumpPromise = (async () => {
                try {
                    while (active && pending.length) {
                        const chunk = pending.shift();
                        pendingMs -= (chunk.length / rate) * 1000;
                        if (!(await send(chunk))) dropped += 1;
                    }
                } finally {
                    pumping = false;
                }
            })();
            return pumpPromise;
        }

        let activePlayer = null;

        function onFrames(inputBuffer, sampleRate) {
            if (!active) return;
            rate = sampleRate;
            // Paused: drop the stale backlog and re-prime, so resuming rebuilds the cushion
            // instead of firing a burst of old audio at the device.
            const p = activePlayer || getPlayer();
            if (p?.paused) {
                if (!priming) reset();
                return;
            }
            const left = inputBuffer.getChannelData(0);
            let mono = left;
            if (inputBuffer.numberOfChannels > 1) {
                const right = inputBuffer.getChannelData(1);
                mono = new Float32Array(left.length);
                for (let index = 0; index < left.length; index += 1) mono[index] = (left[index] + right[index]) / 2;
            } else {
                mono = new Float32Array(left); // copy: the graph reuses its input buffer
            }
            enqueue(mono);
            if (priming && pendingMs < PREBUFFER_MS) return;
            priming = false;
            pump().catch(() => { dropped += 1; });
        }

        // `drain` = the track finished on its own. The cushion we deliberately build up means the
        // server still holds ~PREBUFFER_MS of unplayed audio; clearing the remote stream then would
        // chop the tail off (heard as a freeze/cut right at the end). So on a natural end we flush
        // whatever is still pending and leave the device to play its queue out. A user-initiated
        // stop still clears immediately — silence should be instant when you press stop.
        async function stop(options) {
            if (stopPromise) return stopPromise;
            if (!active && !streamId && !pending.length && !pumping) return false;
            const drain = options?.drain === true;
            const endingStreamId = streamId;
            const endingItemId = activeItemId;
            const bufferedMs = pendingMs;
            active = false;
            activePlayer = null;
            const waveform = getWaveform();
            waveform?.setFrameTap?.(null);
            waveform?.setSpeakerMuted?.(false);
            stopPromise = (async () => {
                try {
                    await pumpPromise.catch(() => {});
                    if (drain) {
                        const tail = pending.slice();
                        reset();
                        for (const chunk of tail) await send(chunk);
                        // The native device still owns the prebuffer already accepted by the
                        // bridge. Hold queue handoff until that tail has played so the next track
                        // cannot flush or overlap it.
                        const settleMs = Math.min(MAX_BACKLOG_MS + 100, Math.max(PREBUFFER_MS, bufferedMs) + 80);
                        await new Promise((resolve) => setTimeout(resolve, settleMs));
                    } else {
                        reset();
                        await window.EveAudioflixNative?.stopStream?.({
                            allDevices: true,
                            itemId: endingStreamId || endingItemId
                        }).catch(() => false);
                    }
                    return true;
                } finally {
                    streamId = '';
                    activeItemId = '';
                    activeDeviceId = '';
                    stopPromise = null;
                }
            })();
            return stopPromise;
        }

        // Async: the preferred tap is an AudioWorklet, whose module must be fetched once. Awaiting
        // it here means even the FIRST track gets the jank-immune audio-thread tap.
        async function start(player, itemId, policy = null) {
            if (stopPromise) await stopPromise.catch(() => {});
            if (active || streamId) await stop().catch(() => {});
            const waveform = getWaveform();
            if (!waveform?.setFrameTap) return false;
            reset();
            dropped = 0;
            activePlayer = player || null;
            activeItemId = String(itemId || 'music');
            activeDeviceId = policy?.outputMode === 'custom' && policy.outputKind === 'native'
                ? String(policy.outputId || '') : '';
            streamId = `music:${activeItemId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
            if (player && typeof waveform.ensureGraph === 'function') {
                waveform.ensureGraph(player);
            }
            const tapRate = await waveform.setFrameTap(onFrames);
            if (!tapRate) {
                streamId = '';
                activeItemId = '';
                activeDeviceId = '';
                return false;
            }
            rate = tapRate;
            // AWAIT the device pre-open. Firing this off without waiting meant the first chunks
            // could reach the bridge while WASAPI was still cold-opening (100-300ms), starving the
            // callback and stuttering the opening seconds. Bounded so a slow or missing server
            // delays the start by at most WARM_TIMEOUT_MS instead of hanging playback.
            //
            // It doubles as the liveness check. shouldSuppressBrowserPlayback() only reads saved
            // state flags, so an armed route whose server has since died still gets here — and
            // committing anyway muted the speakers and streamed PCM nowhere, i.e. a track that
            // "plays" in total silence. A DEFINITE failure now declines the route so the caller
            // falls back to browser playback on the selected output. A timeout does not: a slow
            // but live bridge is still the route the user asked for.
            const TIMED_OUT = Symbol('warm-timeout');
            let warmed = TIMED_OUT;
            try {
                warmed = await Promise.race([
                    Promise.resolve(window.EveAudioflixNative?.warm?.(rate, activeDeviceId)),
                    new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), WARM_TIMEOUT_MS))
                ]);
            } catch { warmed = false; }
            if (warmed !== true) {
                await waveform.setFrameTap(null);
                activePlayer = null;
                streamId = '';
                activeItemId = '';
                activeDeviceId = '';
                return false;
            }
            active = true;
            waveform.setSpeakerMuted?.(true);
            return true;
        }

        return {
            start,
            stop,
            isActive: () => active,
            getStats: () => ({ rate, pendingMs, dropped, priming, streamId, activeItemId })
        };
    };

    ns.ready = true;
})();
