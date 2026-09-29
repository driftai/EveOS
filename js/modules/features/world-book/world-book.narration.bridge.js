window.EveWorldBookNarrationBridge = window.EveWorldBookNarrationBridge || {};

(function (bridge) {
    'use strict';

    const SETTINGS_KEY = 'eveWorldBookNarrationSettings';
    const VOICE_ID = 'world-book-narration';
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
    let pendingReaderOpen = false;
    let latestState = null;
    let activeReaderTarget = null;
    let activeMode = 'world-book';
    const pendingCommands = [];
    const LOCAL_ACTIONS = new Set(['play', 'pause', 'stop', 'previous', 'next', 'seek-progress']);
    const readyTargets = new WeakSet();

    function clamp(value, min, max, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    }

    function normalize(value = {}) {
        return {
            ...defaults,
            ...value,
            enabled: value.enabled !== false,
            engine: value.engine === 'gemini' ? 'gemini' : 'browser',
            rate: clamp(value.rate, 0.5, 2, 1),
            pitch: clamp(value.pitch, 0, 2, 1),
            volume: clamp(value.volume, 0, 1, 1),
            strictVerbatim: value.strictVerbatim !== false,
            backgroundPrefetch: value.backgroundPrefetch !== false,
            routeToAudioflix: value.routeToAudioflix === true,
            cacheMb: clamp(value.cacheMb, 16, 1024, 192),
            cacheDays: clamp(value.cacheDays, 1, 365, 30)
        };
    }

    function settings() {
        try {
            return normalize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
        } catch (_error) {
            return normalize();
        }
    }

    function targets() {
        const values = [];
        const frame = document.querySelector('[data-world-book-frame]')?.contentWindow;
        const detached = window.EveWorldBook?.getDetachedWindow?.();
        if (frame) values.push(frame);
        if (detached && !detached.closed) values.push(detached);
        return values;
    }

    function isWorldBookMessage(event) {
        return targets().includes(event.source)
            && (event.origin === 'http://127.0.0.1:8766' || event.origin === 'http://localhost:8766');
    }

    function send(target, message) {
        try { target?.postMessage?.(message, '*'); } catch (_error) {}
    }

    function broadcastSettings() {
        const message = { type: 'eve-world-book-narration-settings', settings: settings() };
        targets().forEach(target => send(target, message));
        return message.settings;
    }

    function commandTargets() {
        if (activeReaderTarget && targets().includes(activeReaderTarget) && readyTargets.has(activeReaderTarget)) {
            return [activeReaderTarget];
        }
        const detached = window.EveWorldBook?.getDetachedWindow?.();
        if (detached && !detached.closed && readyTargets.has(detached)) return [detached];
        return targets().filter(target => readyTargets.has(target)).slice(0, 1);
    }

    function saveSettings(patch) {
        const next = normalize({ ...settings(), ...(patch || {}) });
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch (_error) {}
        window.dispatchEvent(new CustomEvent('eve:world-book-narration-settings', { detail: next }));
        window.EveWorldBookNarrationRuntime?.configure?.(next);
        return next;
    }

    function broadcastCommand(action, options = {}) {
        if (activeMode === 'local' && LOCAL_ACTIONS.has(action) && window.EveWorldBookNarrationRuntime?.ownsSource?.()) {
            try {
                window.EveWorldBookNarrationRuntime.command(action, options.data || null);
                return 1;
            } catch (_error) {
                return 0;
            }
        }
        const message = {
            type: 'eve-world-book-narration-command',
            action,
            data: options.data && typeof options.data === 'object' ? options.data : null
        };
        const recipients = commandTargets();
        recipients.forEach(target => send(target, message));
        if (!recipients.length && options.queueIfUnavailable !== false) {
            pendingCommands.push(message);
            if (pendingCommands.length > 16) pendingCommands.splice(0, pendingCommands.length - 16);
        }
        return recipients.length;
    }

    function flushPendingCommands(target) {
        pendingCommands.splice(0).forEach(message => send(target, message));
    }

    async function handlePlayback(event, data) {
        let ok = false;
        let reason = '';
        try {
            ok = await window.EveAudioflixNative?.playVoice?.(data.audio, {
                sampleRate: data.sampleRate || 24000,
                channels: 1,
                volume: data.volume ?? 1,
                voiceId: VOICE_ID,
                replace: true
            }) === true;
            if (!ok) reason = 'Audioflix native routing is not active.';
        } catch (error) {
            reason = error.message || String(error);
        }
        send(event.source, {
            type: 'eve-world-book-narration-result',
            requestId: data.requestId,
            ok,
            reason
        });
        window.dispatchEvent(new CustomEvent('eve:world-book-narration-route', {
            detail: { ok, reason, sessionId: data.sessionId || '' }
        }));
    }

    function readSource(source, options = {}) {
        const text = String(source?.text || '');
        if (!text.trim()) return false;
        const normalizedSource = {
            id: String(source?.id || 'eveos:external-reader-source'),
            title: String(source?.title || 'EveOS Reader Source'),
            text,
            kind: String(source?.kind || 'external source'),
            locator: String(source?.locator || 'EveOS')
        };
        const compactPassage = text.replace(/\s+/g, ' ').trim().slice(0, 420);
        const seed = {
            status: 'loading',
            source: {
                id: normalizedSource.id,
                title: normalizedSource.title,
                kind: normalizedSource.kind,
                locator: normalizedSource.locator
            },
            index: 0,
            passageCount: 0,
            passage: compactPassage,
            passageRatio: 0,
            overallRatio: 0,
            passageDuration: 0,
            engine: settings().engine,
            localRuntime: options.local === true
        };
        latestState = seed;
        broadcastSettings();
        window.EveWorldBookNarrationCompanion?.update?.(seed);
        if (options.openCompanion !== false) {
            void window.EveWorldBookNarrationCompanion?.open?.(seed);
        }
        if (options.local === true) {
            const local = window.EveWorldBookNarrationRuntime;
            if (!local?.load || !local?.play) return false;
            activeMode = 'local';
            local.load(normalizedSource);
            if (options.autoplay === true) local.play({ primePromise: options.primePromise || null });
            return true;
        }
        activeMode = 'world-book';
        broadcastCommand('load-source', {
            data: {
                source: normalizedSource,
                autoplay: options.autoplay === true,
                showReader: options.showReader === true
            }
        });
        return true;
    }

    function openReader() {
        pendingReaderOpen = true;
        void window.EveWorldBook?.open?.('world');
        if (broadcastCommand('open-reader', { queueIfUnavailable: false })) pendingReaderOpen = false;
    }

    function openCompanion() {
        if (!latestState?.source) openReader();
        return window.EveWorldBookNarrationCompanion?.open?.(latestState);
    }

    window.addEventListener('message', event => {
        if (!isWorldBookMessage(event)) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'eve-world-book-narration-ready') {
            readyTargets.add(event.source);
            if (!activeReaderTarget) activeReaderTarget = event.source;
            send(event.source, { type: 'eve-world-book-narration-settings', settings: settings() });
            flushPendingCommands(event.source);
            if (pendingReaderOpen) {
                pendingReaderOpen = false;
                send(event.source, { type: 'eve-world-book-narration-command', action: 'open-reader' });
            }
        } else if (data.type === 'eve-world-book-narration-settings-change') {
            saveSettings(data.settings);
        } else if (data.type === 'eve-world-book-narration-play') {
            void handlePlayback(event, data);
        } else if (data.type === 'eve-world-book-narration-stop') {
            void window.EveAudioflixNative?.clearVoices?.(VOICE_ID);
        } else if (data.type === 'eve-world-book-narration-state') {
            activeMode = 'world-book';
            activeReaderTarget = event.source;
            latestState = data.detail && typeof data.detail === 'object' ? data.detail : null;
            window.EveWorldBookNarrationCompanion?.update?.(latestState);
            window.dispatchEvent(new CustomEvent('eve:world-book-narration-state', { detail: latestState }));
            window.dispatchEvent(new CustomEvent('eve:audioflix-reader-state', { detail: latestState }));
        } else if (data.type === 'eve-world-book-narration-detach') {
            openCompanion();
        } else if (data.type === 'eve-world-book-narration-cache-stats') {
            window.dispatchEvent(new CustomEvent('eve:world-book-narration-cache-stats', { detail: data.stats }));
        }
    });

    window.addEventListener('eve:world-book-narration-settings', broadcastSettings);
    window.addEventListener('eve:world-book-narration-local-state', event => {
        activeMode = 'local';
        latestState = event.detail && typeof event.detail === 'object' ? event.detail : null;
        window.EveWorldBookNarrationCompanion?.update?.(latestState);
        window.dispatchEvent(new CustomEvent('eve:world-book-narration-state', { detail: latestState }));
        window.dispatchEvent(new CustomEvent('eve:audioflix-reader-state', { detail: latestState }));
    });
    window.addEventListener('eve:world-book-frame-loading', event => {
        const target = event.detail?.target;
        if (target) {
            readyTargets.delete(target);
            if (activeReaderTarget === target) activeReaderTarget = null;
        }
    });

    Object.assign(bridge, {
        defaults: Object.freeze({ ...defaults }),
        settings,
        saveSettings,
        broadcastSettings,
        broadcastCommand,
        readSource,
        openReader,
        openCompanion,
        getState: () => latestState
    });
})(window.EveWorldBookNarrationBridge);
