window.EveWorldBookNarrationNative = window.EveWorldBookNarrationNative || {};

(function (native) {
    'use strict';
    if (native.ready) return;

    const VOICE_ID = 'world-book-narration';
    let probe = { at: 0, available: false, message: '' };

    async function request(path, options = {}) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), options.timeout || 1800);
        try {
            const response = await fetch(path, {
                method: options.method || 'GET',
                headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
                body: options.body ? JSON.stringify(options.body) : undefined,
                cache: 'no-store',
                signal: controller.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message || `Local audio returned HTTP ${response.status}.`);
            return payload;
        } finally {
            window.clearTimeout(timer);
        }
    }

    async function available(force = false) {
        if (!force && Date.now() - probe.at < 5000) return probe.available;
        try {
            const payload = await request('/api/audioflix/status');
            probe = {
                at: Date.now(),
                available: payload?.ok === true && payload?.playbackAvailable === true,
                message: String(payload?.message || '')
            };
        } catch (error) {
            probe = { at: Date.now(), available: false, message: error?.message || String(error) };
        }
        return probe.available;
    }

    async function play(record, options = {}) {
        if (!(await available())) return false;
        const all = new Uint8Array(record?.pcm || 0);
        const ratio = Math.min(0.999999, Math.max(0, Number(options.startRatio) || 0));
        const start = Math.floor((all.byteLength / 2) * ratio) * 2;
        const bytes = all.slice(start);
        if (!bytes.byteLength) throw new Error('Narration audio is empty.');
        const sampleRate = Number(record?.sampleRate) || 24000;
        const payload = await request('/api/audioflix/play-voice', {
            method: 'POST',
            timeout: 5000,
            body: {
                audio: window.EveWorldBookNarrationAudio.bytesBase64(bytes),
                deviceId: 'default',
                sampleRate,
                channels: 1,
                volume: Number.isFinite(Number(options.volume)) ? Number(options.volume) : 1,
                voiceId: VOICE_ID,
                replace: true
            }
        });
        if (payload?.ok !== true) throw new Error(payload?.message || 'Windows narration output was not accepted.');
        const duration = bytes.byteLength / 2 / sampleRate;
        const startedAt = performance.now();
        options.onStart?.({ duration, startRatio: ratio, output: 'native-default' });
        while (!options.isCancelled?.() && performance.now() - startedAt < duration * 1000) {
            const elapsed = Math.max(0, performance.now() - startedAt) / 1000;
            options.onProgress?.(Math.min(1, ratio + (elapsed / Math.max(duration, 0.001)) * (1 - ratio)), {
                elapsed,
                duration,
                ratio: Math.min(1, elapsed / Math.max(duration, 0.001))
            });
            await new Promise(resolve => window.setTimeout(resolve, 90));
        }
        if (!options.isCancelled?.()) options.onProgress?.(1, { elapsed: duration, duration, ratio: 1 });
        return true;
    }

    async function stop() {
        try {
            const payload = await request('/api/audioflix/clear-voices', {
                method: 'POST',
                body: { deviceId: 'default', sampleRate: 24000, voiceId: VOICE_ID, allDevices: true }
            });
            return payload?.ok === true;
        } catch (_error) {
            return false;
        }
    }

    Object.assign(native, {
        ready: true,
        available,
        play,
        stop,
        getProbe: () => ({ ...probe })
    });
})(window.EveWorldBookNarrationNative);
