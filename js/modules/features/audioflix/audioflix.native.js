window.EveAudioflixNative = window.EveAudioflixNative || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixNative;
    if (ns.ready) return;

    const DEFAULT_TIMEOUT_MS = 1600;
    const DEVICE_SCAN_TIMEOUT_MS = 7500;
    const PCM_SEND_TIMEOUT_MS = 900;
    const PCM_MAX_AGE_MS = 1200, MEDIA_PLAY_TIMEOUT_MS = 5000;
    let deviceCache = null;
    let lastStatus = { ok: false, message: 'Native bridge not checked yet.', devices: [], attempts: [] };
    // After a probe where NO base answered, remember the bridge is down so every native call doesn't
    // re-pay the multi-base probe cost (instant browser fallback on file:// with no server). The hold
    // escalates 10s->20s->40s->80s->120s, so a server coming up is still noticed within minutes.
    let bridgeDownUntil = 0;
    let bridgeMissStreak = 0;
    let bridgeOfflineNoticeShown = false;
    let deviceProbePromise = null;

    function state() {
        return window.EveAudioflixState?.ensure?.() || {};
    }
    function update(patch, reason) {
        return window.EveAudioflixState?.update?.(patch, reason) || state();
    }
    function candidateBases() {
        let saved = state().nativeBridgeBase;
        // Always prefer 127.0.0.1: "localhost" resolves to ::1 first on Windows, so against an
        // IPv4-only server every request eats a ~1-2s IPv6 timeout — which made soundboard audio
        // start late and stream choppily. The bridge allows CORS *, so cross-origin is fine.
        if (saved && saved.includes('localhost')) {
            saved = saved.replace('localhost', '127.0.0.1');
        }
        const bases = [];
        if (saved) bases.push(saved);
        if (/^https?:$/.test(location.protocol)) {
            if (location.origin.includes('localhost')) {
                bases.push(location.origin.replace('localhost', '127.0.0.1'));
            }
            bases.push(location.origin);
        }
        // Fallback guesses only, and 127.0.0.1 only (localhost twins doubled every dead probe for
        // nothing). These ports are not ours to assume — each is identity-checked before use.
        ['8765', '8766', '8767', '8768', '8769', '8770', '3000']
            .forEach((port) => bases.push(`http://127.0.0.1:${port}`));
        return [...new Set(bases.filter(Boolean))];
    }

    async function fetchFromBase(base, path, options = {}) {
        const controller = new AbortController();
        const timeout = Number(options.timeout) || DEFAULT_TIMEOUT_MS;
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(`${base}${path}`, Object.assign({}, options, {
                signal: controller.signal,
                headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {})
            }));
            if (!response.ok) {
                return { ok: false, base, status: response.status, message: response.status === 404
                    ? `Audioflix API is missing on ${base}. Restart that EveOS port so the endpoint loads.`
                    : `Native bridge request failed on ${base} (${response.status}).` };
            }
            const payload = await response.json();
            return Object.assign({ base, bridgeReached: true }, payload || {});
        } finally {
            clearTimeout(timer);
        }
    }

    const BACKOFF = () => window.EveAudioflixNativeBackoff;
    async function fetchJson(path, options = {}) {
        // realtime = live PCM stream lane: never honor the bridge-down cooldown (one transient chunk
        // failure would otherwise mute the router 10-120s mid-song); each chunk has its own timeout.
        if (Date.now() < bridgeDownUntil && options.probe !== true && options.realtime !== true) {
            return { ok: false, cachedDown: true, message: 'Native bridge offline (recent probe failed; will retry shortly).' };
        }
        // ...but a bridge failing EVERY chunk must stop gating playback. See native.backoff.js.
        if (options.realtime === true && BACKOFF()?.shouldSkipRealtime?.()) return { ok: false, cachedDown: true };
        const attempts = [];
        const bases = options.realtime === true ? candidateBases().slice(0, 1) : candidateBases();
        for (const base of bases) {
            // Only a base that proved it is EveOS may carry data; no module = fail closed.
            const I = window.EveAudioflixNativeIdentity;
            if (!I || !(await I.isEveOsBridge(base))) { attempts.push({ base, message: 'Unverified bridge.' }); continue; }
            try {
                const payload = await fetchFromBase(base, path, options);
                if (!payload) {
                    attempts.push({ base, message: 'No native bridge response.' });
                    continue;
                }
                if (payload.bridgeReached === true) {
                    bridgeDownUntil = 0;
                    bridgeMissStreak = 0;
                    BACKOFF()?.noteRealtimeResult?.(true);
                    if (bridgeOfflineNoticeShown) {
                        bridgeOfflineNoticeShown = false;
                        console.info('[Audioflix] Native bridge is back online — CABLE routing and global hotkeys available again.');
                    }
                    update({ nativeBridgeBase: base }, 'audioflix-native-bridge-base');
                    return payload;
                }
                attempts.push({ base, status: payload.status, message: payload.message });
                lastStatus = Object.assign({}, payload, { attempts });
            } catch (error) {
                if (options.realtime === true) window.EveAudioflixNativeIdentity?.invalidate?.(base);
                attempts.push({
                    base,
                    message: error?.name === 'AbortError'
                        ? `Timed out after ${Number(options.timeout) || DEFAULT_TIMEOUT_MS}ms.`
                        : (error?.message || 'Request failed.')
                });
            }
        }
        // Only cache "down" when nothing answered at all (pure network failures); an HTTP error
        // means a server IS there. A realtime chunk failure never arms the cooldown — chunks fire
        // every ~85ms, so a lone hiccup must not blacklist the bridge for device scans/warm.
        if (options.realtime === true) BACKOFF()?.noteRealtimeResult?.(false);
        if (options.realtime !== true && !attempts.some((item) => item.status)) {
            bridgeMissStreak = Math.min(bridgeMissStreak + 1, 5);
            bridgeDownUntil = Date.now() + Math.min(120000, 10000 * Math.pow(2, bridgeMissStreak - 1));
            if (!bridgeOfflineNoticeShown) {
                bridgeOfflineNoticeShown = true;
                console.info('[Audioflix] No EveOS server found — browser-only mode. Start one with start-server.bat, then "Refresh System Outputs" for CABLE routing, hotkeys and path ports.');
            }
        }
        lastStatus = Object.assign({}, lastStatus, {
            ok: false,
            devices: [],
            attempts,
            message: attempts.find((item) => item.status === 404)?.message
                || attempts[0]?.message
                || 'Native bridge unavailable. Start or restart an EveOS HTTP server.'
        });
        return lastStatus;
    }

    async function listSystemOutputs(force = false) {
        const payload = await listSystemDevices(force);
        return Object.assign({}, payload, { devices: (payload.devices || []).filter((device) => device.kind === 'output') });
    }

    async function listSystemInputs(force = false) {
        const payload = await listSystemDevices(force);
        return Object.assign({}, payload, { devices: (payload.devices || []).filter((device) => device.kind === 'input') });
    }

    async function listSystemDevices(force = false) {
        if (deviceCache && !force && Date.now() - deviceCache.at < 5000) return deviceCache.payload;
        if (deviceProbePromise) return deviceProbePromise;
        deviceProbePromise = (async () => {
            const path = force ? '/api/audioflix/devices?refresh=1' : '/api/audioflix/devices';
            // Explicit refresh bypasses the bridge-down cooldown.
            const payload = await fetchJson(path, { timeout: DEVICE_SCAN_TIMEOUT_MS, probe: force === true });
            lastStatus = Object.assign({}, payload, { devices: payload.devices || [] });
            deviceCache = { at: Date.now(), payload: lastStatus };
            return lastStatus;
        })();
        try {
            return await deviceProbePromise;
        } finally {
            deviceProbePromise = null;
        }
    }

    async function warm(sampleRate) {
        if (isBridgeOffline()) return false;
        const current = state();
        if (current.nativeBridgeEnabled !== true || !current.nativeOutputId) return false;
        const payload = await fetchJson('/api/audioflix/warm', {
            method: 'POST',
            body: JSON.stringify({ deviceId: current.nativeOutputId, sampleRate: sampleRate || 24000 }),
            timeout: DEFAULT_TIMEOUT_MS
        });
        return payload?.ok === true;
    }

    // Pre-open the CABLE stream(s) when the bridge is armed so the FIRST Gemini reply (24k) and
    // first soundboard voice (48k) aren't clipped by a cold WASAPI open.
    function maybeWarm() {
        const current = state();
        if (current.nativeBridgeEnabled === true && current.nativeOutputId) {
            warm(24000).catch(() => {});
            warm(48000).catch(() => {});
        }
    }

    const { selectNativeOutput, selectNativeInput, setNativeBridgeEnabled, shouldSuppressBrowserPlayback } =
        window.EveAudioflixNativeRouteState.create({ state, update, maybeWarm, isBridgeOffline });

    async function sendGeminiChunk(audio, detail = {}) {
        if (isBridgeOffline()) return false;
        const current = state();
        if (current.nativeBridgeEnabled !== true || !current.nativeOutputId || !audio) return false;
        const payload = await fetchJson('/api/audioflix/play-pcm', {
            method: 'POST',
            body: JSON.stringify({
                audio,
                deviceId: current.nativeOutputId,
                sampleRate: detail.sampleRate || 24000,
                channels: detail.channels || 1,
                streamId: detail.streamId || null,
                sentAtMs: Date.now(),
                maxAgeMs: PCM_MAX_AGE_MS
            }),
            timeout: PCM_SEND_TIMEOUT_MS,
            realtime: true
        });
        lastStatus = payload;
        return payload?.ok === true;
    }

    // Send a COMPLETE clip as one mixable voice (soundboard layering). One POST per
    // press -> the bridge mixes overlapping voices cleanly (no chunk interleave) and
    // starts it on the next callback (low latency, smooth).
    async function playVoice(audio, detail = {}) {
        if (isBridgeOffline()) return false;
        const current = state();
        if (current.nativeBridgeEnabled !== true || !current.nativeOutputId || !audio) return false;
        const payload = await fetchJson('/api/audioflix/play-voice', {
            method: 'POST',
            body: JSON.stringify({
                audio,
                deviceId: current.nativeOutputId,
                sampleRate: detail.sampleRate || 24000,
                channels: detail.channels || 1,
                volume: detail.volume ?? 1,
                voiceId: detail.voiceId || null,
                replace: detail.replace === true
            }),
            timeout: PCM_SEND_TIMEOUT_MS
        });
        lastStatus = payload;
        return payload?.ok === true;
    }

    async function clearVoices(voiceId, options = {}) {
        const current = state(), allDevices = options.allDevices === true || (!!voiceId && options.allDevices !== false);
        if ((current.nativeBridgeEnabled !== true || !current.nativeOutputId) && !allDevices) return false;
        const payload = await fetchJson('/api/audioflix/clear-voices', {
            method: 'POST',
            body: JSON.stringify({ deviceId: current.nativeOutputId || '', sampleRate: 24000, voiceId: voiceId || null, allDevices }),
            timeout: DEFAULT_TIMEOUT_MS, probe: true
        }).catch(() => null);
        return payload?.ok === true;
    }

    // Stop ONLY the live Gemini streaming lane (play-pcm) — leaves soundboard voices untouched.
    // Used by the audio player's pause/stop so silencing a Gemini reply over CABLE can't wipe
    // soundboard sounds mixing on the same output.
    async function stopStream(options = {}) {
        const current = state(), allDevices = options.allDevices === true;
        if ((current.nativeBridgeEnabled !== true || !current.nativeOutputId) && !allDevices) return false;
        const payload = await fetchJson('/api/audioflix/stop-stream', {
            method: 'POST',
            body: JSON.stringify({ deviceId: current.nativeOutputId || '', sampleRate: 24000, allDevices, itemId: options.itemId || null }),
            timeout: DEFAULT_TIMEOUT_MS, probe: true
        }).catch(() => null);
        return payload?.ok === true;
    }

    async function sendTone(detail = {}) {
        const current = state();
        if (current.nativeBridgeEnabled !== true || !current.nativeOutputId) return false;
        const payload = await fetchJson('/api/audioflix/play-tone', {
            method: 'POST',
            body: JSON.stringify({
                deviceId: current.nativeOutputId,
                sampleRate: detail.sampleRate || 24000,
                frequency: detail.frequency || 660,
                seconds: detail.seconds || 0.55
            }),
            timeout: PCM_SEND_TIMEOUT_MS
        });
        lastStatus = payload;
        return payload;
    }

    async function playMediaItem(item, detail = {}) {
        const current = state();
        const safeItem = item && typeof item === 'object' ? item : {};
        if (current.nativeBridgeEnabled !== true || !current.nativeOutputId || !safeItem.url) return false;
        const payload = await fetchJson('/api/audioflix/play-media', {
            method: 'POST',
            body: JSON.stringify({
                deviceId: current.nativeOutputId,
                itemId: safeItem.id || safeItem.url,
                url: safeItem.url,
                title: safeItem.title || '',
                volume: safeItem.volume ?? 1,
                sampleRate: detail.sampleRate || 48000
            }),
            timeout: MEDIA_PLAY_TIMEOUT_MS
        });
        lastStatus = payload;
        return payload;
    }

    async function setVoiceVolume(voiceId, volume) {
        const current = state();
        if (current.nativeBridgeEnabled !== true || !current.nativeOutputId) return false;
        const payload = await fetchJson('/api/audioflix/set-voice-volume', {
            method: 'POST',
            body: JSON.stringify({
                deviceId: current.nativeOutputId,
                voiceId: voiceId,
                volume: volume
            }),
            timeout: PCM_SEND_TIMEOUT_MS
        });
        return payload?.ok === true;
    }

    async function resolveUrl(targetUrl, force = false) {
        if (!targetUrl) return { ok: false, message: 'Missing target URL' };
        const refresh = force ? '&force=1' : '';
        return fetchJson(`/api/audioflix/resolve-url?url=${encodeURIComponent(targetUrl)}${refresh}`, {
            method: 'GET',
            timeout: 15000
        });
    }

    // Enumerate a playlist's entries (flat — no per-video stream resolve). Needs the EveOS
    // server; a file:// page cannot read youtube.com directly (CORS), so callers keep the last
    // synced state there and surface that syncing needs localhost.
    async function listPlaylist(playlistUrl, force = false) {
        if (!playlistUrl) return { ok: false, reason: 'Missing playlist URL' };
        const refresh = force ? '&refresh=1' : '';
        return fetchJson(`/api/audioflix/playlist?url=${encodeURIComponent(playlistUrl)}${refresh}`, {
            method: 'GET',
            timeout: 30000,
            probe: force === true
        });
    }

    function getProxyUrl(targetUrl) {
        if (!targetUrl) return '';
        const base = state().nativeBridgeBase || (window.location.origin.startsWith('http') ? window.location.origin : 'http://127.0.0.1:8765');
        return `${base}/api/proxy?media=1&url=${encodeURIComponent(targetUrl)}`;
    }

    function isBridgeOffline() {
        return Date.now() < bridgeDownUntil;
    }

    // Served URL for a localized file, via /api/audioflix/port/file (only serves audio inside a
    // folder the localize/scan step registered). Empty with no bridge base so playback falls back.
    function getLocalFileUrl(localPath) {
        if (!localPath || isBridgeOffline()) return '';
        const base = state().nativeBridgeBase || (window.location.origin.startsWith('http') ? window.location.origin : '');
        if (!base) return '';
        return `${base}/api/audioflix/port/file?path=${encodeURIComponent(localPath)}`;
    }

    async function setHotkeys(payload) {
        return fetchJson('/api/audioflix/hotkeys/set', {
            method: 'POST',
            body: JSON.stringify(payload),
            timeout: DEVICE_SCAN_TIMEOUT_MS
        });
    }

    async function clearHotkeys() {
        return fetchJson('/api/audioflix/hotkeys/clear', {
            method: 'POST',
            body: JSON.stringify({}),
            timeout: DEFAULT_TIMEOUT_MS
        });
    }

    async function hotkeyStatus() {
        return fetchJson('/api/audioflix/hotkeys/status', { method: 'GET', timeout: DEFAULT_TIMEOUT_MS });
    }

    // Localization transport (probe / download / link / scan) lives in a sibling module.
    const { probeLocalFile, localizeTrack, linkLocalFile, scanLocalized, readWplFile } =
        window.EveAudioflixNativeLocalize.create({ fetchJson, DEVICE_SCAN_TIMEOUT_MS, isBridgeOffline });
    const { listSpotifyPlaylist, openSpotifySession } = window.EveAudioflixNativeSpotify.create({ fetchJson });
    const { listInstagramCollection, resolveInstagramVideo } = window.EveAudioflixNativeInstagram.create({ fetchJson });

    Object.assign(ns, {
        ready: true,
        isBridgeOffline,
        listSystemDevices,
        listSystemOutputs,
        listSystemInputs,
        selectNativeOutput,
        selectNativeInput,
        setNativeBridgeEnabled,
        sendGeminiChunk,
        playVoice,
        setVoiceVolume,
        clearVoices,
        stopStream,
        sendTone,
        playMediaItem,
        resolveUrl,
        listPlaylist,
        listSpotifyPlaylist, listInstagramCollection, resolveInstagramVideo,
        openSpotifySession,
        localizeTrack,
        scanLocalized,
        readWplFile,
        probeLocalFile,
        linkLocalFile,
        getLocalFileUrl,
        getProxyUrl,
        shouldSuppressBrowserPlayback,
        setHotkeys,
        clearHotkeys,
        hotkeyStatus,
        warm,
        getStatus: function () { return lastStatus; }
    });
})();
