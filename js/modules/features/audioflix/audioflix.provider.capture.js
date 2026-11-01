// Explicit, extension-free provider-tab capture into EveOS's existing native PCM renderer.
window.EveAudioflixProviderCapture = window.EveAudioflixProviderCapture || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;

    const PREBUFFER_MS = 260;
    const MAX_BACKLOG_MS = 1400;
    const MAX_FAILURES = 4;
    let runtime = null;
    let stopPromise = null;
    let last = {
        state: 'idle', message: 'Provider capture is not armed.', authorization: 'required',
        audioTrack: false, nonzeroPcm: false, transport: false, renderer: false,
        endpoint: '', suppression: 'not-checked', chunks: 0, dropped: 0, gain: 1
    };

    const AudioContextCtor = () => window.AudioContext || window.webkitAudioContext;
    const gain = () => {
        const value = Number(window.EveAudioflixState?.ensure?.()?.outputVolume);
        return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
    };
    const emit = () => {
        window.dispatchEvent(new CustomEvent('eve:audioflix-provider-capture', { detail: getStatus() }));
    };
    const update = (patch) => { last = { ...last, ...patch }; emit(); };
    const workletUrl = () => {
        const source = window.EveAudioflixCaptureProcessorSrc;
        if (!source) throw new Error('AudioWorklet capture processor is unavailable.');
        return 'data:application/javascript,' + encodeURIComponent(source);
    };

    function getStatus() {
        return { ...last, active: !!runtime?.active, sessionId: runtime?.session?.sessionId || '' };
    }

    function enqueue(rt, block) {
        if (!rt.active || runtime !== rt) return;
        const copy = block instanceof Float32Array ? block : new Float32Array(block || []);
        if (!copy.length) return;
        let peak = 0;
        for (let index = 0; index < copy.length; index += 1) peak = Math.max(peak, Math.abs(copy[index]));
        if (peak > 0.00005) update({ nonzeroPcm: true });
        rt.queue.push(copy);
        rt.queueMs += (copy.length / rt.sampleRate) * 1000;
        while (rt.queueMs > MAX_BACKLOG_MS && rt.queue.length > 1) {
            rt.queueMs -= (rt.queue.shift().length / rt.sampleRate) * 1000;
            rt.dropped += 1;
        }
        if (!rt.primed && rt.queueMs < PREBUFFER_MS) return;
        rt.primed = true;
        pump(rt).catch(() => {});
    }

    async function pump(rt) {
        if (rt.pumping || !rt.active) return;
        rt.pumping = true;
        try {
            while (rt.active && rt.queue.length) {
                const block = rt.queue.shift();
                rt.queueMs -= (block.length / rt.sampleRate) * 1000;
                const level = gain();
                const audio = window.EveAudioflixAudioBridge?.encodePcm?.(block, 0, block.length, 1);
                const result = await window.EveAudioflixNativeProviderCapture?.send?.(rt.session, audio, {
                    sampleRate: rt.sampleRate, channels: 1, gain: level
                });
                // Stop can complete while an HTTP request is in flight. Never resurrect the UI.
                if (!rt.active || runtime !== rt) return;
                if (result?.ok !== true || result.deviceId !== rt.session.deviceId) {
                    rt.failures += 1;
                    rt.dropped += 1;
                    if (rt.failures >= MAX_FAILURES) {
                        update({ state: 'error', message: result?.message || 'Provider PCM transport failed.', transport: false });
                        queueMicrotask(() => stop('transport-failed'));
                        break;
                    }
                    continue;
                }
                rt.failures = 0;
                rt.chunks += 1;
                update({
                    state: 'active', message: `Native renderer accepted PCM for ${rt.session.endpointLabel}; confirm output at the physical meter.`,
                    transport: true, renderer: result.rendererRunning === true,
                    endpoint: result.deviceId, chunks: rt.chunks, dropped: rt.dropped, gain: level
                });
            }
        } finally {
            rt.pumping = false;
        }
    }

    async function startStream(stream, options = {}) {
        await stop('replace').catch(() => {});
        const audioTrack = stream?.getAudioTracks?.()[0];
        if (!audioTrack) {
            stream?.getTracks?.().forEach((track) => track.stop());
            throw new Error('The selected capture surface did not provide an audio track.');
        }
        const Context = AudioContextCtor();
        let context = null, session;
        try {
            if (!Context) throw new Error('Web Audio is unavailable in this browser.');
            context = new Context({ latencyHint: 'interactive' });
            await context.resume();
            const sampleRate = context.sampleRate;
            session = await window.EveAudioflixNativeProviderCapture.start({
                sampleRate, channels: 1, source: options.source || 'provider-tab'
            });
            await context.audioWorklet.addModule(workletUrl());
            const source = context.createMediaStreamSource(new MediaStream([audioTrack]));
            const node = new AudioWorkletNode(context, 'audioflix-capture-processor', {
                numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
                processorOptions: { blockSize: 4096, channels: 1 }
            });
            const sink = context.createGain();
            sink.gain.value = 0;
            source.connect(node); node.connect(sink); sink.connect(context.destination);
            const rt = runtime = {
                active: true, stream, audioTrack, context, source, node, sink, session, sampleRate,
                queue: [], queueMs: 0, primed: false, pumping: false, chunks: 0, dropped: 0, failures: 0
            };
            node.port.onmessage = (event) => enqueue(rt, event.data);
            audioTrack.addEventListener('ended', () => stop('capture-ended'), { once: true });
            update({
                state: 'armed', message: `Capture authorized; waiting for provider audio on ${session.endpointLabel}.`,
                authorization: options.authorization || 'granted', audioTrack: true,
                transport: false, renderer: session.rendererRunning === true,
                endpoint: session.deviceId, suppression: options.suppression || 'not-applicable',
                chunks: 0, dropped: 0, gain: gain(), nonzeroPcm: false
            });
            return getStatus();
        } catch (error) {
            if (session) await window.EveAudioflixNativeProviderCapture?.stop?.(session).catch(() => {});
            stream?.getTracks?.().forEach((track) => track.stop());
            await context?.close?.().catch(() => {});
            update({ state: 'error', message: error?.message || 'Provider capture failed.', transport: false, renderer: false });
            throw error;
        }
    }

    async function armProviderTab() {
        let stream = null;
        try {
            // Confirm the page can use the local bridge before opening the browser chooser.
            window.EveAudioflixNativeProviderCapture?.captureOrigin?.();
            if (!navigator.mediaDevices?.getDisplayMedia) {
                throw new Error('This browser does not support user-authorized tab capture.');
            }
            update({ state: 'requesting', message: 'Choose the isolated provider tab and enable Share tab audio.', authorization: 'prompting' });
            // The capture chooser must be the first awaited operation after a real user gesture.
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                preferCurrentTab: false,
                selfBrowserSurface: 'exclude',
                surfaceSwitching: 'exclude',
                systemAudio: 'exclude'
            });
            const track = stream.getAudioTracks()[0];
            if (!track) throw new Error('Share tab audio was not enabled for the selected surface.');
            try { await track.applyConstraints?.({ suppressLocalAudioPlayback: true }); } catch {}
            const suppressed = track.getSettings?.().suppressLocalAudioPlayback;
            if (suppressed === false) {
                throw new Error('The browser refused duplicate-output suppression for this capture.');
            }
            return await startStream(stream, {
                source: 'authorized-provider-tab', authorization: 'granted',
                suppression: suppressed === true ? 'confirmed' : 'manual-verification-required'
            });
        } catch (error) {
            stream?.getTracks?.().forEach((track) => track.stop());
            update({ state: 'error', message: error?.message || 'Provider capture request failed.',
                authorization: 'required', audioTrack: false, transport: false, renderer: false });
            throw error;
        }
    }

    async function testTone(durationMs = 1800) {
        window.EveAudioflixNativeProviderCapture?.captureOrigin?.();
        const Context = AudioContextCtor();
        if (!Context) throw new Error('Web Audio is unavailable in this browser.');
        const sourceContext = new Context({ latencyHint: 'interactive' });
        await sourceContext.resume();
        const destination = sourceContext.createMediaStreamDestination();
        const oscillator = sourceContext.createOscillator();
        const level = sourceContext.createGain();
        oscillator.frequency.value = 440;
        level.gain.value = 0.12;
        oscillator.connect(level); level.connect(destination);
        await startStream(destination.stream, { source: 'eveos-test-tone', authorization: 'local-test', suppression: 'not-applicable' });
        oscillator.start();
        oscillator.stop(sourceContext.currentTime + (durationMs / 1000));
        window.setTimeout(() => stop('test-complete').finally(() => sourceContext.close()), durationMs + 500);
        return getStatus();
    }

    async function stop(reason = 'user') {
        if (stopPromise) return stopPromise;
        const rt = runtime;
        if (!rt) return false;
        runtime = null;
        rt.active = false;
        stopPromise = (async () => {
            try {
                rt.node?.port?.postMessage?.({ command: 'stop' });
                rt.node?.disconnect?.(); rt.source?.disconnect?.(); rt.sink?.disconnect?.();
                rt.stream?.getTracks?.().forEach((track) => track.stop());
                await window.EveAudioflixNativeProviderCapture?.stop?.(rt.session).catch(() => false);
                await rt.context?.close?.().catch(() => {});
                const failed = reason === 'transport-failed';
                update({ state: failed ? 'error' : 'idle',
                    message: failed ? last.message : `Provider capture stopped (${reason}).`,
                    authorization: 'required', audioTrack: false, transport: false, renderer: false });
                return true;
            } finally { stopPromise = null; }
        })();
        return stopPromise;
    }

    Object.assign(ns, { ready: true, armProviderTab, testTone, stop, getStatus, startStream });
})(window.EveAudioflixProviderCapture);
