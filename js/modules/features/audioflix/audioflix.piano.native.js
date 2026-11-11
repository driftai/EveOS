window.EveAudioflixPianoNative = window.EveAudioflixPianoNative || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    const STORAGE = 'eveos:audioflix:piano-native:v1';
    const OWNER = 'eveos:audioflix:piano-native-owner:v1';
    let session = null;
    function randomId() { const bytes = crypto.getRandomValues(new Uint8Array(18));
        return 'piano-ui:' + [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); }
    function ownerId() { let value = ''; try { value = localStorage.getItem(OWNER) || ''; } catch (_) {}
        if (value.length < 16) { value = randomId(); try { localStorage.setItem(OWNER, value); } catch (_) {} } return value; }
    function save() { try { if (session) localStorage.setItem(STORAGE, JSON.stringify(session));
        else localStorage.removeItem(STORAGE); } catch (_) {} }
    function restore() { if (session) return session; try { const value = JSON.parse(localStorage.getItem(STORAGE) || 'null');
        if (value?.sessionId && value?.sessionToken && value?.ownerId) session = value; } catch (_) {} return session; }
    const auth = value => ({ sessionId: value.sessionId, sessionToken: value.sessionToken,
        ownerId: value.ownerId, generation: value.generation });
    async function start(detail = {}) { const previous = restore(), generation = Number(previous?.generation || 0) + 1;
        const result = await window.EveAudioflixNativeProviderCapture.pianoNative('start', {
            ownerId: ownerId(), generation, endpoint: detail.endpoint, timeline: detail.timeline,
            soundId: detail.soundId, volumePercent: detail.volumePercent, sampleRate: 48000
        }, 30000);
        session = { ...auth(result), deviceId: result.deviceId, soundId: result.soundId }; save();
        // A native session becomes the only Piano output owner; retire browser PCM.
        await window.EveAudioflixPianoPcm?.revoke?.().catch(() => {});
        if (typeof CustomEvent === 'function') window.dispatchEvent?.(new CustomEvent('eve:audioflix-piano-native-session'));
        return result; }
    async function command(action, detail = {}) { const current = restore();
        if (!current) throw new Error('No server-owned Piano session is attached.');
        try { const result = await window.EveAudioflixNativeProviderCapture.pianoNative(action,
            { ...auth(current), ...detail }, action === 'status' ? 3500 : 5000);
            if (['complete', 'stopped', 'error'].includes(result?.state)) {
                session = null; save();
                if (typeof CustomEvent === 'function') window.dispatchEvent?.(new CustomEvent('eve:audioflix-piano-native-session'));
            }
            return result;
        } catch (error) { if (/session is invalid/i.test(String(error?.message || ''))) { session = null; save(); } throw error; }
    }
    async function attach() { const current = restore(); if (!current) return null;
        try { return await command('status'); } catch (_) { return null; } }
    Object.assign(ns, { ready: true, start, attach, status: () => command('status'),
        pause: detail => command('pause', { paused: typeof detail === 'boolean' ? detail : detail?.paused === true }),
        seek: detail => command('seek', { seconds: Number(typeof detail === 'number' ? detail : detail?.seconds || 0) }),
        volume: detail => command('volume', { volume: Number(typeof detail === 'number' ? detail : detail?.volume || 0) }), stop: () => command('stop'), snapshot: () => restore() });
    if (typeof CustomEvent === 'function')
        window.dispatchEvent?.(new CustomEvent('eve:audioflix-piano-native-ready'));
})(window.EveAudioflixPianoNative);
