window.EveWorldBookNarrationRuntime = window.EveWorldBookNarrationRuntime || {};
(function (runtime) {
    'use strict';
    if (runtime.ready) return;
    const SETTINGS_KEY = 'eveWorldBookNarrationSettings';
    const defaults = window.EveWorldBookNarrationClips.defaults;
    let passages = [];
    let state = emptyState();
    let runToken = 0;
    let pendingStartRatio = 0;
    let pausedFrom = '';
    let pendingStop = Promise.resolve();
    const audio = () => window.EveWorldBookNarrationAudio;
    const cache = () => window.EveWorldBookNarrationCache;
    const clips = () => window.EveWorldBookNarrationClips;
    const gemini = () => window.EveWorldBookNarrationGemini;
    const native = () => window.EveWorldBookNarrationNative;
    const outputs = () => window.EveWorldBookNarrationOutputs;
    const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
    function emptyState() {
        return {
            status: 'idle', source: null, index: 0, passageCount: 0, passage: '',
            passageRatio: 0, overallRatio: 0, passageDuration: 0, engine: '', output: '',
            localRuntime: true, dirtyCount: 0, error: ''
        };
    }
    function settings() {
        const bridge = window.EveWorldBookNarrationBridge;
        try { return { ...defaults, ...(bridge?.settings ? bridge.settings() : JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')) }; }
        catch (_error) { return { ...defaults }; }
    }
    function snapshot(extra = {}) {
        const count = passages.length;
        const overallRatio = count
            ? state.status === 'complete' ? 1 : clamp((state.index + state.passageRatio) / count)
            : 0;
        const clipState = clips()?.state?.() || [];
        return {
            ...state,
            passageCount: count,
            passage: passages[state.index] || '',
            overallRatio,
            clips: clipState,
            dirtyCount: clipState.filter(item => item.dirty).length,
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
        const plan = clips()?.load?.(source, settings()) || [];
        passages = plan.map(item => item.text);
        if (!passages.length) throw new Error('This source does not contain speakable text.');
        const clipSource = clips()?.source?.() || source || {};
        state = {
            ...emptyState(),
            status: 'ready',
            source: {
                id: String(clipSource.id || 'eveos:local-reader-source'),
                title: String(clipSource.title || 'EveOS Reader Source'),
                locator: String(clipSource.locator || 'EveOS'),
                kind: String(clipSource.kind || 'source'),
                revision: String(clipSource.revision || cache()?.hash?.(clipSource.text || '') || '')
            }
        };
        pendingStartRatio = 0;
        return emit();
    }
    function applyPlan(plan) {
        passages = (plan || []).map(item => item.text);
        if (!passages.length) {
            stop();
            state = { ...state, status: 'idle', index: 0, passageRatio: 0, passageDuration: 0 };
        } else {
            state.index = Math.min(state.index, passages.length - 1);
            const clipSource = clips()?.source?.();
            if (clipSource) state.source = { ...state.source, revision: clipSource.revision };
        }
        return emit();
    }
    const previewSource = text => applyPlan(clips()?.preview?.(String(text || ''), settings()) || []);
    const reloadSource = () => applyPlan(clips()?.reload?.(settings()) || []);
    function primeAudio() {
        return audio()?.prime?.() || Promise.resolve({ ok: false, state: 'unavailable', error: 'Web Audio is unavailable.' });
    }
    function speakBrowser(text, config, token, startRatio) {
        return outputs().browser(text, {
            config,
            startRatio,
            isCancelled: () => token !== runToken,
            onStart: () => {
                state.status = 'playing';
                state.engine = 'browser';
                state.output = 'browser';
                emit();
            },
            onProgress: ratio => {
                if (token !== runToken) return;
                state.passageRatio = clamp(ratio);
                emit();
            }
        });
    }
    async function playExternal(route, record, config, token, startRatio) {
        state.status = 'playing';
        state.engine = 'gemini';
        state.output = route === 'audioflix' ? 'audioflix' : 'native-default';
        state.passageDuration = Number(record.durationSec)
            || (record.pcm.byteLength / 2 / (record.sampleRate || 24000));
        emit();
        const ok = await outputs()[route](record, {
            volume: config.volume,
            startRatio,
            isCancelled: () => token !== runToken,
            onProgress: ratio => {
                if (token !== runToken) return;
                state.passageRatio = clamp(ratio);
                emit();
            }
        });
        if (token === runToken && ok !== true) throw new Error('Narration output is unavailable.');
    }
    async function playGemini(index, passage, config, token, startRatio, primePromise, forceRegenerate = false) {
        if (forceRegenerate) await cache()?.remove?.(state.source, passage, index, config);
        let record = forceRegenerate ? null : await cache()?.get?.(state.source, passage, index, config);
        if (token !== runToken) return;
        if (record?.pcm?.byteLength) {
            if (config.routeToAudioflix) return playExternal('audioflix', record, config, token, startRatio);
            if (config.preferNativeOutput !== false && await native()?.available?.()) {
                return playExternal('nativeDefault', record, config, token, startRatio);
            }
            const primed = await (primePromise || primeAudio());
            if (!primed?.ok || audio()?.getState?.() !== 'running') {
                state.status = 'blocked';
                state.error = 'Tap Play to enable audio.';
                emit();
                return;
            }
            state.passageDuration = Number(record.durationSec) || (record.pcm.byteLength / 2 / (record.sampleRate || 24000));
            state.status = 'playing';
            state.engine = 'gemini';
            state.output = 'browser';
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
        const useNativeDefault = config.routeToAudioflix !== true
            && config.preferNativeOutput !== false
            && await native()?.available?.();
        const primed = useNativeDefault ? { ok: true } : await (primePromise || primeAudio());
        if (!useNativeDefault && (!primed?.ok || audio()?.getState?.() !== 'running')) {
            state.status = 'blocked';
            state.error = 'Tap Play to enable audio.';
            emit();
            return;
        }
        state.status = 'generating';
        state.engine = 'gemini';
        state.output = config.routeToAudioflix ? 'audioflix' : (useNativeDefault ? 'native-default' : 'browser');
        state.error = '';
        emit();
        const stream = config.routeToAudioflix || useNativeDefault ? null : audio().beginStream({
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
            await playExternal('audioflix', record, config, token, startRatio);
            return;
        }
        if (useNativeDefault) {
            await playExternal('nativeDefault', record, config, token, startRatio);
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
    async function playPassage(index, baseConfig, token, primePromise, forceRegenerate = false) {
        await pendingStop;
        if (token !== runToken) return;
        const passage = passages[index];
        const startedHash = clips()?.get?.(index)?.hash || '', markRendered = used => { if ((clips()?.get?.(index)?.hash || '') === startedHash) clips()?.markRendered?.(index, used); };
        const config = clips()?.config?.(index, baseConfig) || { ...baseConfig };
        const startRatio = clamp(pendingStartRatio || state.passageRatio);
        pendingStartRatio = 0;
        state.passageRatio = startRatio;
        if (config.engine === 'gemini') {
            try {
                await playGemini(index, passage, config, token, startRatio, primePromise, forceRegenerate);
                if (token === runToken && !['blocked', 'error'].includes(state.status)) markRendered(config);
                return;
            } catch (error) {
                if (token !== runToken) return;
                await outputs()?.stopAll?.('Switching narration output.');
                if (token !== runToken) return;
                if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
                    const fallback = { ...config, engine: 'browser' };
                    state.error = 'Gemini unavailable - using browser speech.';
                    state.engine = 'browser';
                    state.output = 'browser';
                    emit();
                    const completed = await speakBrowser(passage, fallback, token, startRatio);
                    if (token === runToken && completed !== false) markRendered(fallback);
                    return;
                }
                throw error;
            }
        }
        const completed = await speakBrowser(passage, config, token, startRatio);
        if (token === runToken && completed !== false) markRendered(config);
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
        const activeConfig = clips()?.config?.(state.index, settings()) || settings();
        const primePromise = options.primePromise || (activeConfig.engine === 'gemini' ? primeAudio() : null);
        void run(token, primePromise);
        return emit();
    }
    function pause() {
        if (!['playing', 'generating'].includes(state.status)) return snapshot();
        pausedFrom = state.status;
        if (state.output === 'native-default') {
            pendingStartRatio = state.passageRatio;
            runToken += 1;
            void native()?.stop?.();
        }
        outputs()?.pauseBrowser?.();
        void audio()?.pause?.();
        state.status = 'paused';
        emit();
        return snapshot();
    }
    async function resume() {
        if (state.status !== 'paused') return snapshot();
        if (outputs()?.hasBrowserUtterance?.()) {
            outputs()?.resumeBrowser?.();
            state.status = 'playing';
            pausedFrom = '';
            emit();
            return snapshot();
        }
        if (state.output === 'native-default') {
            state.status = 'ready';
            pausedFrom = '';
            return play();
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
        pendingStop = Promise.all([pendingStop, Promise.resolve(outputs()?.stopAll?.('Narration stopped.'))]);
        pausedFrom = '';
        state.status = passages.length ? 'ready' : 'idle';
        state.passageRatio = 0;
        state.passageDuration = 0;
        state.error = '';
        emit();
        return snapshot();
    }
    async function regenerateClip(index) {
        if (!passages.length) throw new Error('Choose something to read first.');
        stop();
        state.index = Math.max(0, Math.min(passages.length - 1, Number(index) || 0));
        state.passageRatio = 0;
        state.passageDuration = 0;
        state.error = '';
        const token = ++runToken;
        const config = clips()?.config?.(state.index, settings()) || settings();
        const primePromise = config.engine === 'gemini' ? primeAudio() : null;
        try {
            await playPassage(state.index, config, token, primePromise, true);
            if (token === runToken && !['blocked', 'error'].includes(state.status)) {
                state.status = 'ready';
                state.passageRatio = 0;
                state.passageDuration = 0;
                emit();
            }
        } catch (error) {
            if (token !== runToken) return snapshot();
            state.status = 'error';
            state.error = error?.message || String(error);
            emit();
        }
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
        if (action === 'reload-source') return reloadSource();
        if (action === 'regenerate-clip') return regenerateClip(data?.index);
        if (action === 'set-clip-engine') { clips()?.choose?.(data?.index, { engine: data?.engine }); return emit(); }
        if (action === 'set-clip-voice') {
            const engine = clips()?.get?.(data?.index)?.engine;
            clips()?.choose?.(data?.index, engine === 'gemini' ? { geminiVoice: data?.voice } : { browserVoice: data?.voice });
            return emit();
        }
        return null;
    }
    const configure = (config = settings()) => { audio()?.setVolume?.(config.volume ?? 1); clips()?.syncDefaults?.(config); if (passages.length) emit(); };
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
        previewSource,
        reloadSource,
        setSourceProvider: provider => clips()?.setProvider?.(provider),
        regenerateClip,
        getState: () => snapshot(),
        ownsSource: () => Boolean(state.source)
    });
})(window.EveWorldBookNarrationRuntime);
