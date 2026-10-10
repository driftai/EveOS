'use strict';

// Serialized into every new Playwright document. Keep this module browser-dependency free.
const MAX_MEDIA_REFS = 32;

function browserInit(payload) {
    'use strict';
    const maxRefs = Math.max(4, Math.min(128, Number(payload?.maxRefs) || 32));
    const initialVolume = Math.max(0, Math.min(1, Number(payload?.initialVolume ?? 1) || 0));
    const host = String(location.hostname || '').toLowerCase();
    if (host !== 'open.spotify.com' || !String(location.pathname || '').startsWith('/embed/')) return;
    if (window.__eveSpotifyManagedControl) return;

    const state = {
        desiredVolume: initialVolume,
        media: [],
        nextId: 1,
        writes: 0,
        lastAppliedAt: 0,
        lastError: '',
        lastPlayingAt: 0
    };
    const safeError = (error) => String(error?.message || error || '').slice(0, 160);
    const prune = () => {
        if (state.media.length <= maxRefs) return;
        const ranked = state.media.slice().sort((a, b) => {
            const ap = a.el && !a.el.paused && !a.el.ended ? 1 : 0;
            const bp = b.el && !b.el.paused && !b.el.ended ? 1 : 0;
            return (bp - ap) || (b.seenAt - a.seenAt);
        });
        state.media = ranked.slice(0, maxRefs);
    };
    const applyOne = (entry, volume = state.desiredVolume) => {
        if (!entry?.el) return false;
        try {
            entry.el.volume = volume;
            entry.lastVolume = Number(entry.el.volume);
            entry.seenAt = Date.now();
            state.writes += 1;
            state.lastAppliedAt = Date.now();
            return Math.abs(entry.lastVolume - volume) <= 0.011;
        } catch (error) {
            state.lastError = safeError(error);
            return false;
        }
    };
    const tag = (element, via = 'hook') => {
        if (!element || !/^(AUDIO|VIDEO)$/i.test(String(element.tagName || ''))) return null;
        let entry = state.media.find((candidate) => candidate.el === element);
        if (!entry) {
            entry = { id: state.nextId++, el: element, via, seenAt: Date.now(), lastVolume: Number(element.volume) };
            state.media.push(entry);
            prune();
        }
        applyOne(entry);
        return entry;
    };

    try {
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) {
            const entry = tag(this, 'play');
            if (entry) state.lastPlayingAt = Date.now();
            applyOne(entry);
            return originalPlay.apply(this, args);
        };
    } catch (error) { state.lastError = `play-hook: ${safeError(error)}`; }

    try {
        const OriginalAudio = window.Audio;
        if (OriginalAudio) {
            const WrappedAudio = function (...args) {
                const element = new OriginalAudio(...args);
                tag(element, 'Audio');
                return element;
            };
            WrappedAudio.prototype = OriginalAudio.prototype;
            Object.setPrototypeOf?.(WrappedAudio, OriginalAudio);
            window.Audio = WrappedAudio;
        }
    } catch (error) { state.lastError = `audio-hook: ${safeError(error)}`; }

    try {
        const originalCreate = Document.prototype.createElement;
        Document.prototype.createElement = function (tagName, ...args) {
            const element = originalCreate.call(this, tagName, ...args);
            if (/^(audio|video)$/i.test(String(tagName))) tag(element, 'createElement');
            return element;
        };
    } catch (error) { state.lastError = `create-hook: ${safeError(error)}`; }

    const discoverDom = () => {
        try { document.querySelectorAll('audio,video').forEach((element) => tag(element, 'dom')); }
        catch (error) { state.lastError = `dom-scan: ${safeError(error)}`; }
    };

    window.__eveSpotifyManagedControl = {
        version: 2,
        seek(seconds) {
            const value = Number(seconds);
            if (!Number.isFinite(value) || value < 0) return { reached: false };
            discoverDom();
            const candidates = state.media.filter(entry => entry.el?.readyState >= 2
                && Number.isFinite(entry.el.duration) && entry.el.duration > 0);
            candidates.sort((a, b) => Number(!b.el.paused && !b.el.ended) - Number(!a.el.paused && !a.el.ended)
                || b.id - a.id);
            const element = candidates[0]?.el;
            if (!element) return { reached: false };
            try {
                const target = Math.min(value, element.duration);
                element.currentTime = target;
                return { reached: true, currentTime: Number(element.currentTime), duration: Number(element.duration) };
            } catch (error) { state.lastError = safeError(error); return { reached: false }; }
        },
        setVolume(value) {
            const n = Number(value);
            if (!Number.isFinite(n)) return this.snapshot();
            state.desiredVolume = Math.max(0, Math.min(1, n));
            discoverDom();
            let reached = 0;
            state.media.forEach((entry) => { if (applyOne(entry)) reached += 1; });
            return { ...this.snapshot(), reached };
        },
        snapshot() {
            discoverDom();
            prune();
            const media = state.media.map((entry) => {
                const element = entry.el;
                return {
                    id: entry.id,
                    tag: String(element?.tagName || '').toLowerCase(),
                    via: entry.via,
                    attached: Boolean(element?.isConnected),
                    paused: Boolean(element?.paused),
                    ended: Boolean(element?.ended),
                    currentTime: Number.isFinite(Number(element?.currentTime)) ? Number(element.currentTime) : null,
                    duration: Number.isFinite(Number(element?.duration)) ? Number(element.duration) : null,
                    volume: Number.isFinite(Number(element?.volume)) ? Number(element.volume) : null,
                    readyState: Number(element?.readyState || 0),
                    encrypted: Boolean(element?.mediaKeys)
                };
            });
            return {
                desiredVolume: state.desiredVolume,
                media,
                mediaCount: media.length,
                playingCount: media.filter((entry) => !entry.paused && !entry.ended).length,
                writes: state.writes,
                lastAppliedAt: state.lastAppliedAt,
                lastPlayingAt: state.lastPlayingAt,
                lastError: state.lastError
            };
        }
    };
}

module.exports = { MAX_MEDIA_REFS, browserInit };
