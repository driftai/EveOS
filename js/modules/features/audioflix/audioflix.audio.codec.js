window.EveAudioflixAudioCodec = window.EveAudioflixAudioCodec || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixAudioCodec;
    if (ns.ready) return;

    const MAX_CACHE_SAMPLES = 12_000_000;
    const MAX_CACHE_SECONDS = 90;
    const cache = new Map();
    const pending = new Map();
    let cachedSamples = 0;
    let cacheEpoch = 0;

    function bufferCost(buffer) {
        return Math.max(0, Number(buffer?.length || 0))
            * Math.max(1, Number(buffer?.numberOfChannels || 1));
    }

    function remember(url, buffer) {
        const cost = bufferCost(buffer);
        if (!cost || Number(buffer?.duration || 0) > MAX_CACHE_SECONDS || cost > MAX_CACHE_SAMPLES) return;
        while (cache.size && cachedSamples + cost > MAX_CACHE_SAMPLES) {
            const oldestKey = cache.keys().next().value;
            const oldest = cache.get(oldestKey);
            cachedSamples -= oldest?.cost || 0;
            cache.delete(oldestKey);
        }
        cache.set(url, { buffer, cost });
        cachedSamples += cost;
    }

    async function getDecodedBuffer(url, getContext) {
        const cached = cache.get(url);
        if (cached?.buffer) {
            cache.delete(url);
            cache.set(url, cached);
            return cached.buffer;
        }
        if (pending.has(url)) return pending.get(url);
        const epoch = cacheEpoch;
        const task = (async () => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Audio fetch failed (${response.status}).`);
            const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
            const context = getContext?.() || new AudioContextCtor();
            const buffer = await context.decodeAudioData(await response.arrayBuffer());
            if (epoch === cacheEpoch) remember(url, buffer);
            return buffer;
        })();
        pending.set(url, task);
        try { return await task; }
        finally { if (pending.get(url) === task) pending.delete(url); }
    }

    function encodeBufferToBase64(audioBuffer, startAt = 0) {
        const float = audioBuffer.getChannelData(0);
        const start = Math.max(0, Math.min(float.length, Math.floor((Number(startAt) || 0) * audioBuffer.sampleRate)));
        const pcm = new Int16Array(float.length - start);
        for (let index = 0; index < pcm.length; index += 1) {
            const sample = Math.max(-1, Math.min(1, float[start + index]));
            pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
        }
        return btoa(binary);
    }

    function clearCache() {
        cacheEpoch += 1;
        pending.clear();
        cache.clear();
        cachedSamples = 0;
    }

    Object.assign(ns, {
        ready: true,
        getDecodedBuffer,
        encodeBufferToBase64,
        clearCache,
        getCacheStats: () => ({ entries: cache.size, samples: cachedSamples, pending: pending.size })
    });
})();
