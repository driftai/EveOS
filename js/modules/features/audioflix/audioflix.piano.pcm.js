window.EveAudioflixPianoPcm = window.EveAudioflixPianoPcm || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    const MAX_PENDING = 3, MAX_RECOVERY_ATTEMPTS = 4, latency = [];
    const instanceId = `piano-owner:${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    let generation = 0, binding = null, session = null, starting = null, pumping = false;
    let heartbeatTimer = 0, heartbeatBusy = false, failureMessage = '', recovering = null, lastStartError = null;
    let dropped = 0, recoveries = 0, lastFailureCategory = '';
    const pending = [];
    const randomToken = () => { const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
        return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); };
    const state = () => window.EveAudioflixState?.getSnapshot?.() || {};
    const endpoint = () => { const current = state(), deviceId = String(current.nativeOutputId || '');
        return current.nativeBridgeEnabled === true && deviceId.startsWith('sd:')
            ? { deviceId, label: current.nativeOutputLabel || deviceId } : null; };
    function metrics() { const values = latency.slice().sort((a, b) => a - b);
        return { samples: values.length, medianMs: Math.round(values[Math.floor(values.length / 2)] || 0),
            worstMs: Math.round(values.at(-1) || 0), queued: pending.length, dropped, recoveries,
            recovering: Boolean(recovering), lastFailureCategory }; }
    function emit(status, message = '') { window.dispatchEvent(new CustomEvent('eve:audioflix-piano-pcm', {
        detail: { status, message, generation, endpoint: session?.deviceId || binding?.endpoint?.deviceId || '', metrics: metrics() }
    })); }
    function stopHeartbeat() { if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = 0; heartbeatBusy = false; }
    function fail(error) { failureMessage = String(error?.message || error || 'Native Piano PCM failed.');
        lastFailureCategory = String(error?.eveCategory || 'unknown');
        const current = binding; void stopSession().finally(() => { emit('failed', failureMessage);
            current?.target?.postMessage?.({ type: 'eveos:piano-pcm-failed', token: current.token,
                generation: current.generation, message: failureMessage }, current.origin); }); }
    function startHeartbeat(expected) { stopHeartbeat(); heartbeatTimer = setInterval(async () => {
        if (heartbeatBusy || binding !== expected || !session) return; heartbeatBusy = true;
        try { await window.EveAudioflixNativeProviderCapture.status(session); }
        catch (error) { void recover(error, expected); }
        finally { heartbeatBusy = false; }
    }, 1500); }
    async function stopSession({ keepPending = false } = {}) { stopHeartbeat(); const previous = session; session = null;
        if (!keepPending) pending.length = 0;
        if (previous) await window.EveAudioflixNativeProviderCapture?.stop?.(previous).catch(() => {}); }
    async function startSession(expected) {
        if (session?.generation === expected.generation && session?.deviceId === expected.endpoint.deviceId) return session;
        if (starting) return starting;
        lastStartError = null;
        starting = (async () => { await stopSession({ keepPending: true }); if (binding !== expected || !expected.endpoint) return null;
            const opened = await window.EveAudioflixNativeProviderCapture.start({ endpoint: expected.endpoint,
                sampleRate: 48000, channels: 1, source: 'piano-post-compressor', lane: 'piano-pcm',
                ownerId: instanceId, generation: expected.generation });
            if (binding !== expected) { await window.EveAudioflixNativeProviderCapture.stop(opened).catch(() => {}); return null; }
            session = opened; lastStartError = null; failureMessage = ''; startHeartbeat(expected); emit('active'); return opened;
        })().catch(error => { if (binding === expected) {
                lastStartError = error; failureMessage = String(error?.message || error);
                if (!retryable(error)) emit('failed', failureMessage);
            } return null; })
            .finally(() => { starting = null; });
        return starting;
    }
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    function retryable(error) { return error?.eveRetryable === true
        || /failed to fetch|timed out|unreachable|invalid or expired|session expired/i.test(String(error?.message || '')); }
    async function recover(error, expected = binding) {
        if (!expected || binding !== expected) return false;
        if (!retryable(error)) { fail(error); return false; }
        if (recovering) return recovering;
        lastFailureCategory = String(error?.eveCategory || 'temporary-transport');
        recovering = (async () => {
            emit('recovering', `Piano PCM transport interrupted (${lastFailureCategory}); retrying safely.`);
            for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS && binding === expected; attempt += 1) {
                await wait([180, 420, 900, 1800][attempt]);
                if (binding !== expected) return false;
                if (session) {
                    try {
                        const status = await window.EveAudioflixNativeProviderCapture.status(session);
                        if (status?.ok === true) { recoveries += 1; failureMessage = ''; startHeartbeat(expected);
                            emit('active', 'Piano PCM transport recovered on the existing native session.'); return true; }
                    } catch (statusError) {
                        error = statusError;
                        if (!retryable(statusError)) { fail(statusError); return false; }
                        if (statusError?.eveCategory === 'session-expired') session = null;
                    }
                }
                if (!session && retryable(error)) {
                    const reopened = await startSession(expected);
                    if (reopened) { recoveries += 1; failureMessage = '';
                        emit('active', 'Piano PCM transport reopened after the bridge interruption.'); return true; }
                    if (lastStartError && binding === expected) {
                        error = lastStartError;
                        if (!retryable(error)) { fail(error); return false; }
                    }
                }
            }
            fail(error); return false;
        })().finally(() => { recovering = null; if (session && pending.length) void pump(); });
        return recovering;
    }
    async function authorize(target, origin, options = {}) {
        const selected = endpoint();
        if (!selected) { binding = null; await stopSession(); return { requested: false, active: false }; }
        if (!target || !origin || origin === 'null') throw new Error('Piano PCM target origin is not authoritative.');
        if (!binding || binding.target !== target || binding.origin !== origin || binding.endpoint.deviceId !== selected.deviceId) {
            generation += 1; failureMessage = ''; binding = { target, origin, endpoint: selected, generation, token: randomToken() }; emit('arming');
        }
        if (failureMessage && options.retry !== true) return { requested: true, active: false,
            token: binding.token, generation: binding.generation, ownerId: instanceId,
            endpointLabel: selected.label, error: failureMessage };
        if (options.retry === true) { failureMessage = ''; lastStartError = null; emit('arming'); }
        let active = await startSession(binding);
        if (!active && lastStartError && retryable(lastStartError)) {
            const expected = binding;
            await recover(lastStartError, expected);
            if (binding === expected) active = session;
        }
        return { requested: true, active: Boolean(active), token: binding.token, generation: binding.generation,
            ownerId: instanceId, endpointLabel: selected.label,
            error: active ? '' : (failureMessage || 'Native Piano PCM route unavailable.') };
    }
    const matches = (event, data) => Boolean(binding && event.source === binding.target && event.origin === binding.origin
        && data.token === binding.token && Number(data.generation) === binding.generation);
    async function pump() {
        if (pumping) return; pumping = true;
        try { while (pending.length && session) { const item = pending.shift();
            const audio = window.EveAudioflixAudioBridge?.encodePcm?.(item.samples, 0, item.samples.length, 1);
            if (!audio) throw new Error('Piano PCM encoder is unavailable.');
            await window.EveAudioflixNativeProviderCapture.send(session, audio, {
                sampleRate: item.sampleRate, channels: 1, gain: 1, maxAgeMs: 120, timeoutMs: 180 });
            latency.push(Math.max(0, Date.now() - item.capturedAtMs)); if (latency.length > 64) latency.shift();
        } } catch (error) { await recover(error, binding);
        } finally { pumping = false; if (pending.length && session && !recovering) queueMicrotask(() => void pump()); }
    }
    function accept(event) { const data = event.data || {};
        if (data.type !== 'piano:eveos-pcm' || !matches(event, data) || !session) return false;
        if (!(data.audio instanceof ArrayBuffer) || data.audio.byteLength < 2 || data.audio.byteLength > 16384) return false;
        if (pending.length >= MAX_PENDING) { pending.shift(); dropped += 1; }
        pending.push({ samples: new Float32Array(data.audio), sampleRate: Number(data.sampleRate) || 48000,
            capturedAtMs: Number(data.capturedAtMs) || Date.now() }); void pump(); return true; }
    async function revoke(target) { if (target && binding?.target !== target) return false;
        const changed = Boolean(binding || session || starting || recovering); generation += 1; binding = null; await stopSession();
        if (changed) emit('disabled'); return changed; }
    window.addEventListener('message', accept);
    Object.assign(ns, { ready: true, authorize, revoke, metrics, accept, recover });
})(window.EveAudioflixPianoPcm);
