window.EveAudioflixPianoNative = window.EveAudioflixPianoNative || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    const STORAGE = 'eveos:audioflix:piano-native:v1';
    const OWNER = 'eveos:audioflix:piano-native-owner:v1';
    let session = null, queueAuth = null;
    const QSTORE = 'eveos:audioflix:piano-native-queue:v1';
    function queueCredential() { if (queueAuth) return queueAuth;
        try { const value = JSON.parse(localStorage.getItem(QSTORE) || 'null');
            if (value?.sessionId && value?.sessionToken && value?.ownerId) queueAuth = value; } catch (_) {}
        return queueAuth; }
    function saveQueue(value) { queueAuth = value;
        try { if (value) localStorage.setItem(QSTORE, JSON.stringify(value));
            else localStorage.removeItem(QSTORE); } catch (_) {} }
    async function queueStatus() { const initial = queueCredential(); if (!initial) return null;
        const result = await window.EveAudioflixNativeProviderCapture.pianoNative('queue-status', initial, 6000);
        const current = result?.currentSession;
        if (current?.sessionId && current?.sessionToken) { session = { ...current }; save(); }
        return result; }
    async function queueArm(detail = {}) { const current = restore();
        if (!current) throw new Error('Start the first native Piano song before arming the queue.');
        const result = await window.EveAudioflixNativeProviderCapture.pianoNative('queue-arm', { ...auth(current), ...detail }, 8000);
        saveQueue(auth(current)); return result; }
    async function queueUpdate(detail = {}) { const initial = queueCredential(); if (!initial) return null;
        return window.EveAudioflixNativeProviderCapture.pianoNative('queue-update', { ...initial, ...detail }, 6000); }
    async function queueStop() { const initial = queueCredential(); if (!initial) return null;
        try { const result = await window.EveAudioflixNativeProviderCapture.pianoNative('queue-stop', initial, 6000);
            if (result?.currentSession?.sessionId) { session = { ...result.currentSession }; save(); }
            return result; }
        finally { saveQueue(null); } }
    async function activeStatus() { const current = queueCredential();
        if (current) { const q = await queueStatus();
            if (q?.currentStatus) return q.active && q.currentStatus.state === 'complete'
                ? { ...q.currentStatus, state: 'rendering', message: 'Preparing the next native Piano queue song…' }
                : q.currentStatus; }
        return command('status'); }
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
    async function start(detail = {}) { if (queueCredential()) await queueStop().catch(() => saveQueue(null));
        const previous = restore(), generation = Number(previous?.generation || 0) + 1;
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
        try { return await activeStatus(); } catch (_) { return null; } }
    Object.assign(ns, { ready: true, start, attach, queueArm, queueStatus, queueUpdate, queueStop, status: activeStatus,
        pause: async detail => { if (queueCredential()) await queueStatus(); return command('pause', { paused: typeof detail === 'boolean' ? detail : detail?.paused === true }); },
        seek: async detail => { if (queueCredential()) await queueStatus(); return command('seek', { seconds: Number(typeof detail === 'number' ? detail : detail?.seconds || 0) }); },
        volume: async detail => { if (queueCredential()) await queueStatus(); return command('volume', { volume: Number(typeof detail === 'number' ? detail : detail?.volume || 0) }); },
        stop: async () => { if (queueCredential()) { await queueStatus().catch(() => {}); await queueStop().catch(() => {}); } return command('stop'); },
        snapshot: () => restore() });
    if (typeof CustomEvent === 'function')
        window.dispatchEvent?.(new CustomEvent('eve:audioflix-piano-native-ready'));
})(window.EveAudioflixPianoNative);
