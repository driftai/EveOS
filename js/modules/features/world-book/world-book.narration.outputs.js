window.EveWorldBookNarrationOutputs = window.EveWorldBookNarrationOutputs || {};

(function (outputs) {
    'use strict';
    if (outputs.ready) return;

    let utterance = null;
    let progressTimer = 0;
    const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

    function browserVoices() {
        return window.speechSynthesis?.getVoices?.() || [];
    }

    function browser(text, options = {}) {
        if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
            return Promise.reject(new Error('Browser speech is unavailable in this browser.'));
        }
        const startRatio = clamp(options.startRatio);
        const offset = Math.floor(text.length * startRatio);
        const spoken = text.slice(offset);
        if (!spoken.trim()) return Promise.resolve(true);
        return new Promise((resolve, reject) => {
            stopBrowser();
            const next = new SpeechSynthesisUtterance(spoken);
            const selected = browserVoices().find(voice => voice.voiceURI === options.config?.browserVoice);
            if (selected) { next.voice = selected; next.lang = selected.lang; }
            next.rate = Number(options.config?.rate) || 1;
            next.pitch = Number.isFinite(Number(options.config?.pitch)) ? Number(options.config.pitch) : 1;
            next.volume = Number.isFinite(Number(options.config?.volume)) ? Number(options.config.volume) : 1;
            const words = Math.max(1, spoken.trim().split(/\s+/).length);
            const estimateMs = Math.max(500, words / (175 * Math.max(0.5, next.rate)) * 60000);
            const startedAt = performance.now();
            options.onStart?.();
            progressTimer = window.setInterval(() => {
                if (options.isCancelled?.()) return;
                const ratio = clamp(startRatio + ((performance.now() - startedAt) / estimateMs) * (1 - startRatio));
                options.onProgress?.(Math.min(0.98, ratio));
            }, 180);
            next.onboundary = event => options.onProgress?.(
                clamp((offset + Math.max(0, Number(event.charIndex) || 0)) / Math.max(1, text.length))
            );
            next.onend = () => { utterance = null; clearProgress(); resolve(true); };
            next.onerror = event => {
                utterance = null;
                clearProgress();
                if (['canceled', 'interrupted'].includes(event.error)) resolve(false);
                else reject(new Error('Browser narration failed: ' + (event.error || 'unknown error')));
            };
            utterance = next;
            window.speechSynthesis.speak(next);
        });
    }

    async function audioflix(record, options = {}) {
        const bytes = new Uint8Array(record.pcm || 0);
        const ratio = clamp(options.startRatio);
        const start = Math.floor((bytes.byteLength / 2) * ratio) * 2;
        const encoded = window.EveWorldBookNarrationAudio.bytesBase64(bytes.slice(start));
        const ok = await window.EveAudioflixNative?.playVoice?.(encoded, {
            sampleRate: record.sampleRate || 24000,
            channels: 1,
            volume: options.volume ?? 1,
            voiceId: 'world-book-narration',
            replace: true
        });
        if (ok !== true) throw new Error('Audioflix native routing is not active.');
        return timed(record, { ...options, startRatio: ratio });
    }

    function nativeDefault(record, options = {}) {
        return window.EveWorldBookNarrationNative?.play?.(record, options);
    }

    async function timed(record, options = {}) {
        const ratio = clamp(options.startRatio);
        const duration = Number(record.durationSec) || (record.pcm.byteLength / 2 / (record.sampleRate || 24000));
        const remainingMs = Math.max(100, duration * (1 - ratio) * 1000);
        const startedAt = performance.now();
        options.onStart?.({ duration, startRatio: ratio });
        while (!options.isCancelled?.() && performance.now() - startedAt < remainingMs) {
            options.onProgress?.(clamp(ratio + ((performance.now() - startedAt) / remainingMs) * (1 - ratio)));
            await new Promise(resolve => window.setTimeout(resolve, 90));
        }
        if (!options.isCancelled?.()) options.onProgress?.(1);
        return true;
    }

    function clearProgress() {
        window.clearInterval(progressTimer);
        progressTimer = 0;
    }

    function pauseBrowser() { window.speechSynthesis?.pause?.(); }
    function resumeBrowser() { window.speechSynthesis?.resume?.(); }
    function stopBrowser() {
        window.speechSynthesis?.cancel?.();
        utterance = null;
        clearProgress();
    }

    async function stopAll(reason = 'Narration stopped.') {
        window.EveWorldBookNarrationGemini?.cancel?.(reason);
        window.EveWorldBookNarrationAudio?.stop?.({ preserveContext: true });
        stopBrowser();
        let audioflix = null;
        try { audioflix = window.EveAudioflixNative?.clearVoices?.('world-book-narration'); } catch (_error) {}
        await Promise.allSettled([
            Promise.resolve(window.EveWorldBookNarrationNative?.stop?.()),
            Promise.resolve(audioflix)
        ]);
    }

    Object.assign(outputs, {
        ready: true,
        browser,
        audioflix,
        nativeDefault,
        pauseBrowser,
        resumeBrowser,
        stopBrowser,
        stopAll,
        hasBrowserUtterance: () => Boolean(utterance)
    });
})(window.EveWorldBookNarrationOutputs);
