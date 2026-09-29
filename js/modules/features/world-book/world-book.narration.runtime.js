window.EveWorldBookNarrationRuntime = window.EveWorldBookNarrationRuntime || {};
(function (runtime) {
    'use strict';
    if (runtime.ready) return;
    const SETTINGS_KEY = 'eveWorldBookNarrationSettings';
    const defaults = {
        enabled: true,
        engine: 'browser',
        browserVoice: '',
        geminiVoice: 'Aoede',
        rate: 1,
        pitch: 1,
        volume: 1,
        strictVerbatim: true,
        backgroundPrefetch: true,
        routeToAudioflix: false,
        cacheMb: 192,
        cacheDays: 30
    };
    let passages = [];
    let state = emptyState();
    let runToken = 0;
    let pendingStartRatio = 0;
    let browserUtterance = null;
    let browserTimer = 0;
    let pausedFrom = '';
    const audio = () => window.EveWorldBookNarrationAudio;
    const cache = () => window.EveWorldBookNarrationCache;
    const gemini = () => window.EveWorldBookNarrationGemini;
    const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
    function emptyState() {
        return {
            status: 'idle',
            source: null,
            index: 0,
            passageCount: 0,
            passage: '',
            passageRatio: 0,
            overallRatio: 0,
            passageDuration: 0,
            engine: '',
            localRuntime: true,
            error: ''
        };
    }
    function settings() {
        const bridge = window.EveWorldBookNarrationBridge;
        if (bridge?.settings) return { ...defaults, ...bridge.settings() };
        try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
        catch (_error) { return { ...defaults }; }
    }
    function split(text, max = 600) {
        const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
        if (!normalized) return [];
        const pieces = normalized.split(/(?<=[.!?]["'\u201d\u2019)\]]?)\s+/u);
        const output = [];
        let current = '';
        for (const raw of pieces) {
            let part = raw.trim();
            while (part.length > max) {
                let cut = part.lastIndexOf(' ', max);
                if (cut < max * 0.45) cut = max;
                if (current) { output.push(current); current = ''; }
                output.push(part.slice(0, cut).trim());
                part = part.slice(cut).trim();
            }
            if (!part) continue;
            const candidate = current ? current + ' ' + part : part;
            if (candidate.length <= max) current = candidate;
            else { if (current) output.push(current); current = part; }
        }
        if (current) output.push(current);
        return output.filter(value => /[\p{L}\p{N}]/u.test(value));
    }
    function snapshot(extra = {}) {
        const count = passages.length;
        const overallRatio = count
            ? state.status === 'complete' ? 1 : clamp((state.index + state.passageRatio) / count)
            : 0;
        return {
            ...state,
            passageCount: count,
            passage: passages[state.index] || '',
            overallRatio,
            localRuntime: true,
            ...extra
        };
    }
    function emit(extra = {}) {
        state = snapshot(extra);
        window.dispatchEvent(new CustomEvent('eve:world-book-narration-local-state', { detail: state }));
        return state;
    }
    function load(source) {
        stop();
        const text = String(source?.text || '');
        passages = split(text);
        if (!passages.length) throw new Error('This source does not contain speakable text.');
        state = {
            ...emptyState(),
            status: 'ready',
            source: {
                id: String(source?.id || 'eveos:local-reader-source'),
                title: String(source?.title || 'EveOS Reader Source'),
                locator: String(source?.locator || 'EveOS'),
                kind: String(source?.kind || 'source'),
                revision: cache()?.hash?.(text) || ''
            }
        };
        pendingStartRatio = 0;
        return emit();
    }
    function primeAudio() {
        return audio()?.prime?.() || Promise.resolve({ ok: false, state: 'unavailable', error: 'Web Audio is unavailable.' });
    }
    function browserVoices() {
        return window.speechSynthesis?.getVoices?.() || [];
    }
    function speakBrowser(text, config, token, startRatio) {
        if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
            return Promise.reject(new Error('Browser speech is unavailable in this browser.'));
        }
        const offset = Math.floor(text.length * clamp(startRatio));
        const spoken = text.slice(offset);
        if (!spoken.trim()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(spoken);
            const selected = browserVoices().find(voice => voice.voiceURI === config.browserVoice);
            if (selected) { utterance.voice = selected; utterance.lang = selected.lang; }
            utterance.rate = Number(config.rate) || 1;
            utterance.pitch = Number.isFinite(Number(config.pitch)) ? Number(config.pitch) : 1;
            utterance.volume = Number.isFinite(Number(config.volume)) ? Number(config.volume) : 1;
            const words = Math.max(1, spoken.trim().split(/\s+/).length);
            const estimateMs = Math.max(500, words / (175 * Math.max(0.5, utterance.rate)) * 60000);
            const startedAt = performance.now();
            state.status = 'playing';
            state.engine = 'browser';
            emit();
            window.clearInterval(browserTimer);
            browserTimer = window.setInterval(() => {
                if (token !== runToken || state.status !== 'playing') return;
                const ratio = clamp(startRatio + ((performance.now() - startedAt) / estimateMs) * (1 - startRatio));
                state.passageRatio = Math.min(0.98, ratio);
                emit();
            }, 180);
            utterance.onboundary = event => {
                if (token !== runToken) return;
                state.passageRatio = clamp((offset + Math.max(0, Number(event.charIndex) || 0)) / Math.max(1, text.length));
                emit();
            };
            utterance.onend = () => { browserUtterance = null; window.clearInterval(browserTimer); resolve(); };
            utterance.onerror = event => {
                browserUtterance = null;
                window.clearInterval(browserTimer);
                if (['canceled', 'interrupted'].includes(event.error)) resolve();
                else reject(new Error('Browser narration failed: ' + (event.error || 'unknown error')));
            };
            browserUtterance = utterance;
            window.speechSynthesis.speak(utterance);
        });
    }
    async function playAudioflix(record, config, token, startRatio) {
        const bytes = new Uint8Array(record.pcm || 0);
        const start = Math.floor((bytes.byteLength / 2) * clamp(startRatio)) * 2;
        const encoded = audio().bytesBase64(bytes.slice(start));
        const ok = await window.EveAudioflixNative?.playVoice?.(encoded, {
            sampleRate: record.sampleRate || audio().SAMPLE_RATE,
            channels: 1,
            volume: config.volume ?? 1,
            voiceId: 'world-book-narration',
            replace: true
        });
        if (token !== runToken) return;
        if (ok !== true) throw new Error('Audioflix native routing is not active.');
        state.status = 'playing';
        state.engine = 'gemini';
        state.passageDuration = Number(record.durationSec) || 0;
        emit();
        const durationMs = Math.max(100, state.passageDuration * (1 - clamp(startRatio)) * 1000);
        const startedAt = performance.now();
        while (token === runToken && performance.now() - startedAt < durationMs) {
            if (state.status === 'paused') { await new Promise(resolve => setTimeout(resolve, 80)); continue; }
            state.passageRatio = clamp(startRatio + ((performance.now() - startedAt) / durationMs) * (1 - startRatio));
            emit();
            await new Promise(resolve => setTimeout(resolve, 120));
        }
    }
    async function playGemini(index, passage, config, token, startRatio, primePromise) {
        let record = await cache()?.get?.(state.source, passage, index, config);
        if (token !== runToken) return;
        if (record?.pcm?.byteLength) {
            const primed = await (primePromise || primeAudio());
            if (!primed?.ok || audio()?.getState?.() !== 'running') {
                state.status = 'blocked';
                state.error = 'Tap Play to enable audio.';
                emit();
                return;
            }
            state.passageDuration = Number(record.durationSec) || (record.pcm.byteLength / 2 / (record.sampleRate || 24000));
            if (config.routeToAudioflix) return playAudioflix(record, config, token, startRatio);
            state.status = 'playing';
            state.engine = 'gemini';
            emit();
            await audio().playRecord(record, {
                volume: config.volume,
                startRatio,
                onProgress: ratio => {
                    if (token !== runToken) return;
                    state.passageRatio = clamp(ratio);
                    emit();
                }
            });
            return;
        }
        const primed = await (primePromise || primeAudio());
        if (!primed?.ok || audio()?.getState?.() !== 'running') {
            state.status = 'blocked';
            state.error = 'Tap Play to enable audio.';
            emit();
            return;
        }
        state.status = 'generating';
        state.engine = 'gemini';
        state.error = '';
        emit();
        const stream = config.routeToAudioflix ? null : audio().beginStream({
            volume: config.volume,
            onStart: () => {
                if (token !== runToken) return;
                state.status = 'playing';
                state.error = '';
                emit();
            },
            onProgress: value => {
                if (token !== runToken || !value?.started) return;
                state.passageDuration = Math.max(state.passageDuration || 0, Number(value.scheduledSeconds) || 0);
                const timing = value.timing || audio().timing();
                state.passageRatio = clamp(timing.ratio);
                emit();
            }
        });
        const result = await gemini().synthesize(passage, config, {
            stream,
            isCancelled: () => token !== runToken
        });
        if (token !== runToken) return;
        record = await cache().put(state.source, passage, index, passages.length, config, result);
        state.passageDuration = Number(result.durationSec) || 0;
        if (Number(result.duplicateChunks) > 0) {
            console.warn('Narration dropped duplicate PCM chunks:', result.duplicateChunks);
        }
        if (config.routeToAudioflix) {
            await playAudioflix(record, config, token, startRatio);
            return;
        }
        if (!result.streamed) {
            state.status = 'blocked';
            state.error = 'Tap Play to enable audio.';
            emit();
            return;
        }
        state.status = 'playing';
        emit();
        await audio().waitForIdle(ratio => {
            if (token !== runToken) return;
            state.passageRatio = clamp(ratio);
            emit();
        }, startRatio);
    }
    async function playPassage(index, config, token, primePromise) {
        const passage = passages[index];
        const startRatio = clamp(pendingStartRatio || state.passageRatio);
        pendingStartRatio = 0;
        state.passageRatio = startRatio;
        if (config.engine === 'gemini') {
            try {
                await playGemini(index, passage, config, token, startRatio, primePromise);
                return;
            } catch (error) {
                if (token !== runToken) return;
                if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
                    state.error = 'Gemini unavailable - using browser speech.';
                    state.engine = 'browser';
                    emit();
                    await speakBrowser(passage, config, token, startRatio);
                    return;
                }
                throw error;
            }
        }
        await speakBrowser(passage, config, token, startRatio);
    }
    async function run(token, primePromise) {
        try {
            while (token === runToken && state.index < passages.length) {
                const config = settings();
                if (!config.enabled) throw new Error('Narration is disabled in Search Monitor.');
                await playPassage(state.index, config, token, primePromise);
                primePromise = null;
                if (token !== runToken || state.status === 'blocked') return;
                state.index += 1;
                state.passageRatio = 0;
                state.passageDuration = 0;
                emit();
            }
            if (token === runToken) {
                state.index = Math.max(0, passages.length - 1);
                state.passageRatio = 1;
                state.status = 'complete';
                state.error = '';
                emit();
            }
        } catch (error) {
            if (token !== runToken) return;
            state.status = error?.code === 'AUDIO_BLOCKED' ? 'blocked' : 'error';
            state.error = error?.message || String(error);
            emit();
        }
    }
    function play(options = {}) {
        if (!passages.length) throw new Error('Choose something to read first.');
        if (state.status === 'paused') return resume();
        if (state.status === 'complete') { state.index = 0; state.passageRatio = 0; }
        const token = ++runToken;
        const primePromise = options.primePromise || (settings().engine === 'gemini' ? primeAudio() : null);
        void run(token, primePromise);
        return emit();
    }
    function pause() {
        if (!['playing', 'generating'].includes(state.status)) return snapshot();
        pausedFrom = state.status;
        window.speechSynthesis?.pause?.();
        void audio()?.pause?.();
        state.status = 'paused';
        emit();
        return snapshot();
    }
    async function resume() {
        if (state.status !== 'paused') return snapshot();
        if (browserUtterance) {
            window.speechSynthesis?.resume?.();
            state.status = 'playing';
            pausedFrom = '';
            emit();
            return snapshot();
        }
        const result = await audio()?.resume?.();
        if (!result?.ok || audio()?.getState?.() !== 'running') {
            state.status = 'blocked';
            state.error = 'Tap Play to enable audio.';
            emit();
            return snapshot();
        }
        state.status = pausedFrom === 'generating' ? 'generating' : 'playing';
        pausedFrom = '';
        state.error = '';
        emit();
        return snapshot();
    }
    function stop() {
        runToken += 1;
        gemini()?.cancel?.('Narration stopped.');
        audio()?.stop?.({ preserveContext: true });
        window.speechSynthesis?.cancel?.();
        window.clearInterval(browserTimer);
        browserUtterance = null;
        try { window.EveAudioflixNative?.clearVoices?.('world-book-narration'); } catch (_error) {}
        pausedFrom = '';
        state.status = passages.length ? 'ready' : 'idle';
        state.passageRatio = 0;
        state.passageDuration = 0;
        state.error = '';
        emit();
        return snapshot();
    }
    function seekProgress(value, autoplay = false) {
        if (!passages.length) return snapshot();
        const ratio = clamp((Number(value) || 0) / 1000);
        stop();
        if (ratio >= 1) {
            state.index = passages.length - 1;
            state.passageRatio = 1;
            state.status = 'complete';
            return emit();
        }
        const scaled = ratio * passages.length;
        state.index = Math.min(passages.length - 1, Math.floor(scaled));
        state.passageRatio = clamp(scaled - state.index);
        pendingStartRatio = state.passageRatio;
        emit();
        if (autoplay) play();
        return snapshot();
    }
    function step(delta) {
        if (!passages.length) return snapshot();
        stop();
        state.index = Math.max(0, Math.min(passages.length - 1, state.index + delta));
        emit();
        return play();
    }
    function command(action, data = null) {
        if (action === 'play') return play();
        if (action === 'pause') return pause();
        if (action === 'stop') return stop();
        if (action === 'previous') return step(-1);
        if (action === 'next') return step(1);
        if (action === 'seek-progress') return seekProgress(data?.value, data?.autoplay === true);
        return null;
    }
    function configure(config = settings()) {
        audio()?.setVolume?.(config.volume ?? 1);
    }
    window.addEventListener('eve:world-book-narration-settings', event => configure(event.detail || settings()));
    window.addEventListener('beforeunload', () => {
        runToken += 1;
        gemini()?.close?.('EveOS unloading.');
        void audio()?.close?.();
    }, { once: true });
    Object.assign(runtime, {
        ready: true,
        load,
        play,
        pause,
        resume,
        stop,
        command,
        primeAudio,
        configure,
        settings,
        snapshot,
        getState: () => snapshot(),
        ownsSource: () => Boolean(state.source)
    });
})(window.EveWorldBookNarrationRuntime);
