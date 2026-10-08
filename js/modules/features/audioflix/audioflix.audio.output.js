window.EveAudioflixAudioOutput = window.EveAudioflixAudioOutput || {};

(function () {
    const ns = window.EveAudioflixAudioOutput;
    ns.createController = function createController(deps) {
        const { ensureAudio, getAudioContext, state, dispatch, runtime } = deps;
    async function applySink(deviceId) {
        const player = ensureAudio();
        const sinkId = String(deviceId || '');
        let applied = false;
        if (typeof player.setSinkId === 'function') {
            await player.setSinkId(sinkId);
            applied = true;
        }
        const context = getAudioContext?.();
        if (typeof context?.setSinkId === 'function') {
            try {
                await context.setSinkId(sinkId);
                applied = true;
            } catch (error) {
                console.warn('[Audioflix] Web Audio output did not accept the selected sink:', error);
            }
        }
        return applied;
    }

    async function selectOutput() {
        const devices = navigator.mediaDevices || {};
        if (typeof devices.selectAudioOutput !== 'function') {
            runtime.lastStatus = 'Browser output picker unavailable';
            dispatch('eve:audioflix-playback', { status: runtime.lastStatus, unsupported: true });
            return false;
        }
        const device = await devices.selectAudioOutput();
        if (!device?.deviceId) return false;
        return await commitOutput(device.deviceId, device.label || 'Selected output device');
    }

    // Persist a chosen output device and route both Audioflix's own player and the
    // live Gemini voice context to it (so picking "CABLE Input" arms the mic-spoof).
    async function commitOutput(deviceId, label) {
        const sinkId = String(deviceId || '');
        const isDefault = !sinkId;
        const applied = await applySink(sinkId);
        window.EveAudioflixState?.update?.({
            preferredSinkId: sinkId,
            preferredSinkLabel: isDefault ? '' : (label || 'Selected output device'),
            nativeBridgeEnabled: false,
            nativeSuppressBrowserPlayback: false,
            nativeRouteDefaultV2Applied: true,
            routeMode: isDefault ? 'browser' : 'browser-selective'
        }, 'audioflix-output-device');
        try { await window.EveAudioflixGemini?.applyVoiceSink?.(window.audioInputContext); } catch { }
        runtime.lastStatus = isDefault
            ? 'Audioflix is using the system default output.'
            : (applied ? `Output routed to ${label || 'selected device'}` : 'Output saved for supported browsers');
        dispatch('eve:audioflix-playback', { status: runtime.lastStatus, deviceId: sinkId, label: isDefault ? 'System default output' : label });
        return true;
    }

    // Enumerate available audio output devices for the in-app dropdown picker.
    // Labels are only populated in a secure context after a media permission has
    // been granted at least once; we still return ids so selection works.
    async function listOutputs() {
        const devices = navigator.mediaDevices || {};
        if (typeof devices.enumerateDevices !== 'function') return [];
        try {
            const all = await devices.enumerateDevices();
            return all
                .filter((d) => d.kind === 'audiooutput')
                .map((d, i) => ({
                    deviceId: d.deviceId,
                    label: d.label || `Output device ${i + 1}`,
                    anonymous: !d.label
                }));
        } catch (error) {
            console.warn('[Audioflix] enumerateDevices failed:', error);
            return [];
        }
    }

    function hasNamedOutputs(list) {
        return (list || []).some((device) => device && device.label && !device.anonymous);
    }

    async function unlockDeviceLabels() {
        const devices = navigator.mediaDevices || {};

        // Browsers only expose audio-output device NAMES in a secure context (https or
        // http://localhost). On file:// or a LAN IP, getUserMedia can't reveal them, so
        // "Grant Output Access" can never work there. Say so plainly + point to the fix.
        if (window.isSecureContext !== true || typeof devices.enumerateDevices !== 'function') {
            runtime.lastStatus = 'Output names need a secure page. Open EveOS at http://localhost:8765 (not file://) to unlock names, or use the Native Bridge / Windows Mixer below.';
            dispatch('eve:audioflix-playback', { status: runtime.lastStatus, insecure: true });
            return false;
        }

        let micPermissionTried = false;
        let stream = null;
        try {
            if (typeof devices.getUserMedia === 'function') {
                micPermissionTried = true;
                // Hold an active mic capture and enumerate WHILE it is live; Chromium/Edge
                // expose labels lazily, so retry briefly before giving up. Track is stopped
                // in finally so we never leave the mic open.
                stream = await devices.getUserMedia({ audio: true, video: false });
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    if (hasNamedOutputs(await listOutputs())) {
                        runtime.lastStatus = 'Audio output names unlocked. Pick CABLE Input from the list.';
                        dispatch('eve:audioflix-playback', { status: runtime.lastStatus, labelsUnlocked: true });
                        return true;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 150));
                }
            }
            if (typeof devices.selectAudioOutput === 'function') {
                const device = await devices.selectAudioOutput();
                if (device?.deviceId) {
                    await commitOutput(device.deviceId, device.label || 'Selected output device');
                    runtime.lastStatus = `Output access granted for ${device.label || 'selected output'}.`;
                    dispatch('eve:audioflix-playback', { status: runtime.lastStatus, labelsUnlocked: true });
                    return true;
                }
            }
            runtime.lastStatus = micPermissionTried
                ? 'Mic permission is granted, but Edge is still hiding output names. Try "Pick Browser Output", the Native Bridge, or Windows Mixer.'
                : 'Cannot unlock device names here; use Pick Browser Output, Native Bridge, or Windows Mixer.';
            dispatch('eve:audioflix-playback', { status: runtime.lastStatus, unsupported: true });
            return false;
        } catch (error) {
            runtime.lastStatus = error?.name === 'NotAllowedError'
                ? 'Microphone access was blocked, so output names stay hidden. Allow the mic for this site, then try Grant Output Access again.'
                : (error?.message || 'Device-name unlock was blocked');
            dispatch('eve:audioflix-playback', { status: runtime.lastStatus, error: true });
            return false;
        } finally {
            if (stream) stream.getTracks().forEach((track) => { try { track.stop(); } catch { } });
        }
    }

    async function setOutputById(deviceId, label) {
        return await commitOutput(deviceId, deviceId ? (label || 'Selected output device') : 'System default output');
    }

    // Music plays as ONE continuous browser stream (the native PCM lane stays for short
    // soundboard clips), so the control layer routes it by resolving which BROWSER sink lands
    // on the routed endpoint: the explicitly picked browser output when set, otherwise the
    // browser device whose name matches the armed Native Bridge output — both surfaces list
    // the same Windows endpoint (e.g. "CABLE Input (VB-Audio Virtual Cable)"), the native side
    // just carries a host-API suffix and MME name truncation.
    const HOST_API_SUFFIX_RE = /\((mme|windows directsound|windows wasapi|windows wdm-ks|asio|core audio|alsa)\)/gi;
    let nativeSinkMatch = { key: '', deviceId: '', label: '', at: 0 };

    function normalizeDeviceLabel(value) {
        return String(value || '')
            .replace(HOST_API_SUFFIX_RE, ' ')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    function deviceLabelsMatch(a, b) {
        const left = normalizeDeviceLabel(a);
        const right = normalizeDeviceLabel(b);
        if (!left || !right) return false;
        const shorter = left.length <= right.length ? left : right;
        const longer = left.length <= right.length ? right : left;
        return shorter.length >= 6 && longer.startsWith(shorter);
    }

    async function resolvePlaybackSink() {
        const current = state();
        if (current.preferredSinkId) {
            return {
                deviceId: current.preferredSinkId,
                label: current.preferredSinkLabel || 'selected output',
                source: 'browser-selective'
            };
        }
        if (current.nativeBridgeEnabled !== true || !current.nativeOutputId || !current.nativeOutputLabel) return null;
        if (nativeSinkMatch.key !== current.nativeOutputLabel || Date.now() - nativeSinkMatch.at >= 15000) {
            const outputs = await listOutputs();
            const match = (outputs || []).find(
                (device) => device && !device.anonymous && deviceLabelsMatch(device.label, current.nativeOutputLabel)
            );
            nativeSinkMatch = {
                key: current.nativeOutputLabel,
                deviceId: match?.deviceId || '',
                label: match?.label || '',
                at: Date.now()
            };
        }
        return nativeSinkMatch.deviceId
            ? { deviceId: nativeSinkMatch.deviceId, label: nativeSinkMatch.label, source: 'native-label-match' }
            : { deviceId: '', label: current.nativeOutputLabel, source: 'native-unmatched' };
    }

    // Route the browser <audio> player (used for continuous music) onto the resolved sink and
    // return the human label; when a native endpoint is armed but has no browser twin here, say
    // so once instead of silently playing on the default device. Returns '' when unrouted.
    let nativeSinkNoticeShown = false;
    async function routeBrowserStream(item) {
        let routed = null;
        try { routed = await resolvePlaybackSink(); } catch { routed = null; }
        if (routed?.deviceId) {
            try {
                await applySink(routed.deviceId);
                nativeSinkNoticeShown = false;
                return routed.label || 'selected browser output';
            }
            catch { /* Fall back to default browser audio output when custom sink ID is rejected/unpermitted */ }
        } else if (routed?.source === 'native-unmatched' && !nativeSinkNoticeShown) {
            nativeSinkNoticeShown = true;
            runtime.lastStatus = `No browser output matches the native "${routed.label}" route; this stream uses the default device. Click "Grant Output Access" so music can follow the native output.`;
            dispatch('eve:audioflix-playback', { status: runtime.lastStatus, item });
        }
        return '';
    }

    async function tryNativePlayback(safeItem) {
        if (safeItem.type === 'sound') return false; // Force soundboard sounds to use voice playback path for layering/volume support!
        if (!window.EveAudioflixNative?.shouldSuppressBrowserPlayback?.()) return false;
        const isWav = String(safeItem.url || '').toLowerCase().split('?')[0].split('#')[0].endsWith('.wav');
        if (!isWav) return false;
        const payload = await window.EveAudioflixNative?.playMediaItem?.({
            ...safeItem,
            volume: window.EveAudioflixOutputPort?.effective?.(safeItem.volume) ?? safeItem.volume
        });
        if (payload?.ok !== true) {
            return false;
        }
        runtime.currentItem = safeItem;
        runtime.lastStatus = `Native route playing ${safeItem.title || 'audio'} -> ${state().nativeOutputLabel || 'selected output'}`;
        dispatch('eve:audioflix-playback', { status: runtime.lastStatus, item: safeItem, native: true, payload });
        window.EveAudioflixState?.recordPlay?.(safeItem);
        return true;
    }

    function browserOutputStatus() {
        const devices = navigator.mediaDevices || {};
        const player = ensureAudio();
        return {
            secureContext: window.isSecureContext === true,
            hasSetSinkId: typeof player.setSinkId === 'function',
            hasAudioContextSink: typeof AudioContext !== 'undefined'
                && typeof AudioContext.prototype?.setSinkId === 'function',
            hasOutputPicker: typeof devices.selectAudioOutput === 'function',
            hasEnumerate: typeof devices.enumerateDevices === 'function',
            activeSinkId: player.sinkId || ''
        };
    }

        return {
            applySink,
            selectOutput,
            listOutputs,
            setOutputById,
            unlockDeviceLabels,
            tryNativePlayback,
            browserOutputStatus,
            resolvePlaybackSink,
            routeBrowserStream
        };
    };
})();
