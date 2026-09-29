window.EveWorldBookNarrationAudio = window.EveWorldBookNarrationAudio || {};

(function (audio) {
    'use strict';
    if (audio.ready) return;

    const SAMPLE_RATE = 24000;
    const SILENCE = 96;
    let context = null;
    let gain = null;
    let scheduledUntil = 0;
    let streamStartedAt = 0;
    let activeSources = new Set();
    let resumePromise = null;

    function AudioCtor() {
        return window.AudioContext || window.webkitAudioContext || null;
    }

    function clamp(value, min, max, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    }

    function ensureContext() {
        if (context && context.state !== 'closed') return context;
        const Ctor = AudioCtor();
        if (!Ctor) throw new Error('Web Audio is unavailable in this browser.');
        context = new Ctor({ sampleRate: SAMPLE_RATE });
        gain = context.createGain();
        gain.gain.value = 1;
        gain.connect(context.destination);
        scheduledUntil = context.currentTime;
        return context;
    }

    function prime() {
        let ctx;
        try { ctx = ensureContext(); }
        catch (error) {
            return Promise.resolve({ ok: false, state: 'unavailable', error: error.message || String(error) });
        }
        if (ctx.state === 'running') return Promise.resolve({ ok: true, state: 'running', error: '' });
        try {
            if (!resumePromise) {
                resumePromise = Promise.resolve(ctx.resume?.()).catch(error => ({ __error: error })).finally(() => {
                    resumePromise = null;
                });
            }
            return Promise.resolve(resumePromise).then(result => {
                const ok = ctx.state === 'running';
                return { ok, state: ctx.state, error: ok ? '' : (result?.__error?.message || 'Tap Play to enable audio.') };
            });
        } catch (error) {
            return Promise.resolve({ ok: false, state: ctx.state || 'suspended', error: error.message || String(error) });
        }
    }

    function setVolume(value) {
        if (gain) gain.gain.value = clamp(value, 0, 1, 1);
    }

    function base64Bytes(value) {
        const binary = atob(String(value || ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    }

    function bytesBase64(value) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
    }

    function joinBytes(chunks) {
        const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const output = new Uint8Array(length);
        let offset = 0;
        chunks.forEach(chunk => {
            output.set(chunk, offset);
            offset += chunk.byteLength;
        });
        return output;
    }

    function pcmBounds(value) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
        const frames = Math.floor(bytes.byteLength / 2);
        if (!frames) return { bytes, first: -1, last: -1, frames: 0 };
        const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2);
        let first = -1;
        let last = -1;
        for (let index = 0; index < frames; index += 1) {
            if (Math.abs(view.getInt16(index * 2, true)) <= SILENCE) continue;
            if (first < 0) first = index;
            last = index;
        }
        return { bytes, first, last, frames };
    }

    function trimPcm(value, options = {}) {
        const { bytes, first, last, frames } = pcmBounds(value);
        if (first < 0 || !frames) return new Uint8Array(0);
        const pad = Math.floor(SAMPLE_RATE * 0.012);
        const start = options.leading === false ? 0 : Math.max(0, first - pad);
        const end = options.trailing === false ? frames : Math.min(frames, last + pad + 1);
        return bytes.slice(start * 2, end * 2);
    }

    function isSilent(value) {
        return pcmBounds(value).first < 0;
    }

    function fingerprint(bytes) {
        let code = 2166136261;
        const stride = Math.max(1, Math.floor(bytes.length / 96));
        for (let index = 0; index < bytes.length; index += stride) {
            code ^= bytes[index];
            code = Math.imul(code, 16777619);
        }
        return `${bytes.length}:${(code >>> 0).toString(36)}`;
    }

    function bufferFromPcm(value, sampleRate = SAMPLE_RATE) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
        const frames = Math.floor(bytes.byteLength / 2);
        if (!frames) return null;
        const buffer = context.createBuffer(1, frames, sampleRate);
        const output = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2);
        for (let index = 0; index < frames; index += 1) {
            output[index] = view.getInt16(index * 2, true) / 32768;
        }
        return buffer;
    }

    function schedule(value, sampleRate = SAMPLE_RATE, volume = 1) {
        if (!context || context.state !== 'running') return 0;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
        if (!bytes.byteLength) return 0;
        setVolume(volume);
        const buffer = bufferFromPcm(bytes, sampleRate);
        if (!buffer) return 0;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        const when = Math.max(scheduledUntil, context.currentTime + 0.018);
        if (!streamStartedAt) streamStartedAt = when;
        scheduledUntil = when + buffer.duration;
        activeSources.add(source);
        source.onended = () => activeSources.delete(source);
        source.start(when);
        return buffer.duration;
    }

    function beginStream(options = {}) {
        let pending = null;
        let started = false;
        let duplicateChunks = 0;
        let lastFingerprint = '';
        let scheduledSeconds = 0;
        return {
            push(value, sampleRate = SAMPLE_RATE) {
                const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
                if (!bytes.byteLength) return 0;
                const fp = fingerprint(bytes);
                if (fp === lastFingerprint) {
                    duplicateChunks += 1;
                    return 0;
                }
                lastFingerprint = fp;
                let added = 0;
                if (pending) {
                    const playable = started ? pending.bytes : trimPcm(pending.bytes, { trailing: false });
                    added = schedule(playable, pending.sampleRate, options.volume ?? 1);
                    if (added > 0 && !started) {
                        started = true;
                        options.onStart?.();
                    }
                    scheduledSeconds += added;
                }
                pending = { bytes, sampleRate };
                options.onProgress?.({ started, scheduledSeconds, timing: timing() });
                return added;
            },
            finish() {
                if (pending) {
                    const playable = trimPcm(pending.bytes, { leading: !started, trailing: true });
                    const added = schedule(playable, pending.sampleRate, options.volume ?? 1);
                    if (added > 0 && !started) {
                        started = true;
                        options.onStart?.();
                    }
                    scheduledSeconds += added;
                }
                pending = null;
                options.onProgress?.({ started, scheduledSeconds, timing: timing() });
                return { started, duplicateChunks, scheduledSeconds };
            },
            get started() { return started; },
            get duplicateChunks() { return duplicateChunks; }
        };
    }

    async function playRecord(record, options = {}) {
        const result = await prime();
        if (!result.ok || context?.state !== 'running') {
            const error = new Error('Tap Play to enable audio.');
            error.code = 'AUDIO_BLOCKED';
            throw error;
        }
        stop({ preserveContext: true });
        const bytes = trimPcm(record?.pcm, { leading: true, trailing: true });
        if (!bytes.byteLength) throw new Error('Narration audio contains only digital silence.');
        setVolume(options.volume ?? 1);
        const buffer = bufferFromPcm(bytes, Number(record?.sampleRate) || SAMPLE_RATE);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        const ratio = clamp(options.startRatio, 0, 0.999999, 0);
        const when = context.currentTime + 0.018;
        streamStartedAt = when;
        scheduledUntil = when + buffer.duration * (1 - ratio);
        activeSources.add(source);
        source.onended = () => activeSources.delete(source);
        source.start(when, buffer.duration * ratio);
        options.onStart?.({ duration: buffer.duration, startRatio: ratio });
        return waitForIdle(options.onProgress, ratio);
    }

    function timing() {
        if (!context || !streamStartedAt) return { elapsed: 0, duration: 0, ratio: 0 };
        const duration = Math.max(0, scheduledUntil - streamStartedAt);
        const elapsed = Math.min(duration, Math.max(0, context.currentTime - streamStartedAt));
        return { elapsed, duration, ratio: duration > 0 ? elapsed / duration : 0 };
    }

    function waitForIdle(onProgress, startRatio = 0) {
        return new Promise(resolve => {
            const check = () => {
                const value = timing();
                const ratio = startRatio + value.ratio * (1 - startRatio);
                onProgress?.(ratio, value);
                if (!context || (!activeSources.size && context.currentTime + 0.02 >= scheduledUntil)) {
                    onProgress?.(1, timing());
                    resolve(true);
                    return;
                }
                window.setTimeout(check, 45);
            };
            check();
        });
    }

    function pause() {
        try { return context?.suspend?.() || Promise.resolve(); }
        catch (_error) { return Promise.resolve(); }
    }

    function resume() {
        return prime();
    }

    function stop(options = {}) {
        activeSources.forEach(source => {
            try { source.stop(); } catch (_error) {}
        });
        activeSources.clear();
        streamStartedAt = 0;
        if (context) scheduledUntil = context.currentTime;
        if (!options.preserveContext && context?.state === 'closed') {
            context = null;
            gain = null;
        }
    }

    async function close() {
        stop({ preserveContext: true });
        try { await context?.close?.(); } catch (_error) {}
        context = null;
        gain = null;
        scheduledUntil = 0;
    }

    Object.assign(audio, {
        ready: true,
        SAMPLE_RATE,
        prime,
        setVolume,
        base64Bytes,
        bytesBase64,
        joinBytes,
        trimPcm,
        isSilent,
        fingerprint,
        beginStream,
        playRecord,
        pause,
        resume,
        stop,
        close,
        timing,
        waitForIdle,
        getState: () => context?.state || 'uninitialized'
    });
})(window.EveWorldBookNarrationAudio);
