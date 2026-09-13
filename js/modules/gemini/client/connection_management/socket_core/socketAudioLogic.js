/**
 * socketAudioLogic.js
 * Handles Gemini audio messages, Live tool execution, and interruption-safe playback routing.
 */

console.log("socketAudioLogic.js loading...");

(function () {
    const LiveAudioGate = window.GeminiLiveAudioGate = window.GeminiLiveAudioGate || {
        epoch: 0,
        tail: Promise.resolve(),
        lastCancelReason: '',
        enqueue(work) {
            const ticket = this.epoch;
            const run = this.tail.then(async () => {
                if (ticket !== this.epoch) return { cancelled: true };
                const isCurrent = () => ticket === this.epoch;
                return work(isCurrent, ticket);
            });
            this.tail = run.catch(() => undefined);
            return run;
        },
        cancel(reason = 'interrupted') {
            this.epoch += 1;
            this.lastCancelReason = String(reason);
            return this.epoch;
        }
    };

    const activeToolCalls = new Set();
    const completedToolCalls = new Set();
    const cancelledToolCalls = new Set();
    const TOOL_TIMEOUT_MS = 8000;
    const TOOL_HISTORY_MAX = 128;

    function rememberCompleted(requestId) {
        completedToolCalls.add(requestId);
        if (completedToolCalls.size > TOOL_HISTORY_MAX) {
            const oldest = completedToolCalls.values().next().value;
            completedToolCalls.delete(oldest);
        }
    }

    function isStaleSocket(event) {
        const source = event?.currentTarget || event?.target || null;
        return !!source && !!window.webSocket && source !== window.webSocket;
    }

    async function waitForToolBridge(timeoutMs = 1500) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (window.GeminiLiveToolBridge?.execute) return window.GeminiLiveToolBridge;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return window.GeminiLiveToolBridge || null;
    }

    function dispatchToolState(detail) {
        try {
            window.dispatchEvent(new CustomEvent('eve:gemini-tool-state', { detail }));
        } catch (error) { /* optional UI signal */ }
    }

    async function handleGeminiToolCall(event, data) {
        if (isStaleSocket(event)) return;
        const call = data?.call || {};
        const requestId = String(call.requestId || '');
        const name = String(call.name || '');
        if (!requestId || !name) return;
        if (activeToolCalls.has(requestId) || completedToolCalls.has(requestId)) return;

        activeToolCalls.add(requestId);
        dispatchToolState({ requestId, name, state: 'executing', at: Date.now() });
        if (typeof updateConnectionStatus === 'function') {
            updateConnectionStatus('connected', 'Executing EveOS Tool...');
        }

        let response;
        try {
            const bridge = await waitForToolBridge();
            if (!bridge?.execute) throw new Error('EveOS agentic tool bridge is unavailable');
            response = await Promise.race([
                bridge.execute(call),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('Tool execution timed out')),
                    TOOL_TIMEOUT_MS
                ))
            ]);
            if (!response || typeof response !== 'object' || Array.isArray(response)) {
                response = { ok: true, result: response ?? null };
            }
        } catch (error) {
            response = {
                ok: false,
                error: String(error?.message || error || 'Tool execution failed').slice(0, 500)
            };
        } finally {
            activeToolCalls.delete(requestId);
        }

        if (cancelledToolCalls.delete(requestId)) {
            rememberCompleted(requestId);
            dispatchToolState({ requestId, name, state: 'cancelled', at: Date.now() });
            if (typeof updateConnectionStatus === 'function') updateConnectionStatus('connected', 'Connected');
            return;
        }

        const socket = window.webSocket;
        if (isStaleSocket(event) || !socket || socket.readyState !== WebSocket.OPEN) {
            dispatchToolState({ requestId, name, state: 'stale', at: Date.now() });
            return;
        }

        socket.send(JSON.stringify({
            type: 'gemini_tool_response',
            requestId,
            name,
            response
        }));
        rememberCompleted(requestId);
        dispatchToolState({ requestId, name, state: response.ok === false ? 'error' : 'complete', at: Date.now() });
        if (typeof updateConnectionStatus === 'function') updateConnectionStatus('connected', 'Connected');
    }

    function handleGeminiToolCancellation(data) {
        const requestId = String(data?.requestId || '');
        if (!requestId) return;
        cancelledToolCalls.add(requestId);
        dispatchToolState({
            requestId,
            name: String(data?.name || ''),
            state: 'cancelled',
            at: Date.now()
        });
    }

    async function handleGeminiInterruption(data = {}) {
        LiveAudioGate.cancel(data.reason || 'provider_barge_in');

        try {
            if (typeof stopAllAudioPlayback === 'function') stopAllAudioPlayback();
            else window.AudioIngestCore?.InterimIngestHandler?.stopAll?.('provider_barge_in');
        } catch (error) {
            console.warn('[GeminiAudio] Browser interruption cleanup failed:', error);
        }

        try {
            window.workletNode?.port?.postMessage?.({ command: 'stop' });
            window._workletCache = {};
        } catch (error) { /* worklet is optional */ }

        try {
            if (Array.isArray(window.audioQueue)) window.audioQueue.length = 0;
            if (Array.isArray(window.generalAudioQueue)) window.generalAudioQueue.length = 0;
            window.isPlayingFromQueue = false;
        } catch (error) { /* queue globals are optional */ }

        try { await window.EveAudioflixNative?.stopStream?.(); }
        catch (error) { console.warn('[GeminiAudio] Native stream interruption failed:', error); }

        window.dispatchEvent(new CustomEvent('eve:gemini-interrupted', {
            detail: { reason: data.reason || 'provider_barge_in', at: Date.now() }
        }));
    }

    async function handleAudioMessage(data) {
        if (window.SocketGlobalState && !window.SocketGlobalState.geminiApiReady) {
            window.SocketGlobalState.geminiApiReady = true;
            if (typeof updateConnectionStatus === 'function') updateConnectionStatus('connected', 'Connected');
        }

        if (typeof playProcessedAudio !== 'undefined' && !playProcessedAudio) {
            if (typeof ensureAudioPlayerUI === 'function') ensureAudioPlayerUI(data.audio || data.audio_data);
            return;
        }

        const isCompleteAudio = data.is_transcription === true && data.audio_data;
        const isSequential = data.sequential === true;
        const isInterimAudio = !isCompleteAudio;
        const interimAudioDisabled = (typeof playInterimAudio !== 'undefined' && !playInterimAudio);

        if (isInterimAudio && interimAudioDisabled) {
            if (typeof ensureAudioPlayerUI === 'function') ensureAudioPlayerUI(data.audio || data.audio_data);
            return;
        }

        const audioData = data.audio || data.audio_data;
        if (audioData) {
            window.dispatchEvent(new CustomEvent('eve:gemini-audio-output', {
                detail: {
                    kind: isCompleteAudio ? 'complete' : 'interim',
                    sequential: isSequential,
                    chars: String(audioData || '').length,
                    audio: audioData,
                    at: Date.now()
                }
            }));
        }

        if (typeof ensureAudioPlayerUI === 'function') ensureAudioPlayerUI(audioData);
        else console.error("ensureAudioPlayerUI missing! Cannot update UI.");

        const shouldAutoPlay = (isCompleteAudio && (typeof playProcessedAudio !== 'undefined' && playProcessedAudio)) ||
            (isInterimAudio && (typeof playInterimAudio !== 'undefined' && playInterimAudio)) ||
            (typeof autoAudioPlay !== 'undefined' && autoAudioPlay);

        async function ensurePlaybackReady() {
            if (window.AudioProcessingControlsAgentic?.ensureAudioContextReady) {
                return await window.AudioProcessingControlsAgentic.ensureAudioContextReady();
            }
            if (window.audioInputContext?.state === 'suspended') {
                await window.audioInputContext.resume();
            }
            return true;
        }

        async function playWithRecovery(chunk, finalAudio, isCurrent) {
            const ready = await ensurePlaybackReady();
            if (!isCurrent()) return;
            if (!ready) {
                if (typeof displayMessage === 'function') {
                    displayMessage('System Message: Gemini audio is queued until the page receives an audio-unlock click/key press.', true);
                }
                return;
            }
            try {
                await injestAudioChuckToPlay(chunk, finalAudio);
            } catch (error) {
                if (!isCurrent()) return;
                console.warn('[socketAudioLogic] Audio ingest failed; rebuilding audio context once:', error);
                try {
                    if (window.AudioContextState) {
                        window.AudioContextState.audioContextInitialized = false;
                        window.AudioContextState.audioInputContext = null;
                    }
                    window.audioInputContext = null;
                    await ensurePlaybackReady();
                    if (!isCurrent()) return;
                    await injestAudioChuckToPlay(chunk, finalAudio);
                } catch (retryError) {
                    console.error('[socketAudioLogic] Audio retry failed:', retryError);
                    if (typeof displayMessage === 'function') {
                        displayMessage('System Message: Gemini audio playback failed after retry; use the visible player controls for this response.', true);
                    }
                }
            }
            if (!isCurrent() && typeof stopAllAudioPlayback === 'function') stopAllAudioPlayback();
        }

        if (shouldAutoPlay && typeof injestAudioChuckToPlay === 'function' && audioData) {
            await LiveAudioGate.enqueue(async (isCurrent) => {
                if (!isCurrent()) return;
                let nativeHandled = false;
                try {
                    nativeHandled = await window.EveAudioflixNative?.sendGeminiChunk?.(audioData, {
                        kind: isCompleteAudio ? 'complete' : 'interim',
                        sequential: isSequential,
                        sampleRate: 24000,
                        channels: 1
                    }) === true;
                } catch (nativeError) {
                    console.warn('[socketAudioLogic] Native Audioflix route skipped:', nativeError);
                }
                if (!isCurrent()) return;

                try {
                    await window.EveAudioflixGemini?.mirrorAudioChunk?.(audioData, {
                        kind: isCompleteAudio ? 'complete' : 'interim',
                        sequential: isSequential
                    });
                } catch (monitorError) {
                    console.warn('[socketAudioLogic] Gemini monitor mirror skipped:', monitorError);
                }
                if (!isCurrent()) return;
                if (nativeHandled && window.EveAudioflixNative?.shouldSuppressBrowserPlayback?.()) return;
                await playWithRecovery(audioData, isCompleteAudio, isCurrent);
            });
        }
    }

    // The core router loads immediately before this file. Wrap it instead of duplicating its
    // large credential/history/session state machine, and rebind an already-created socket too.
    const previousSocketMessageHandler = window.handleSocketMessage;
    if (typeof previousSocketMessageHandler === 'function' && !previousSocketMessageHandler.__eveLiveToolAware) {
        const wrappedSocketMessageHandler = async function (event) {
            let data = null;
            try { data = JSON.parse(event.data); }
            catch (error) { return previousSocketMessageHandler(event); }

            if (isStaleSocket(event)) return;
            if (data?.type === 'gemini_interrupted') {
                await handleGeminiInterruption(data);
                return;
            }
            if (data?.type === 'gemini_tool_call') {
                await handleGeminiToolCall(event, data);
                return;
            }
            if (data?.type === 'gemini_tool_call_cancelled') {
                handleGeminiToolCancellation(data);
                return;
            }
            if (data?.type === 'gemini_tool_response_ack' || data?.type === 'gemini_tool_response_rejected') {
                dispatchToolState({
                    requestId: String(data.requestId || ''),
                    name: String(data.name || ''),
                    state: data.type === 'gemini_tool_response_ack' ? 'acknowledged' : 'rejected',
                    reason: String(data.reason || ''),
                    at: Date.now()
                });
                return;
            }
            return previousSocketMessageHandler(event);
        };
        wrappedSocketMessageHandler.__eveLiveToolAware = true;
        wrappedSocketMessageHandler.__evePrevious = previousSocketMessageHandler;
        window.handleSocketMessage = wrappedSocketMessageHandler;
        if (window.webSocket?.onmessage === previousSocketMessageHandler) {
            window.webSocket.onmessage = wrappedSocketMessageHandler;
        }
    }

    window.handleAudioMessage = handleAudioMessage;
    window.handleGeminiInterruption = handleGeminiInterruption;
})();

console.log("socketAudioLogic.js loaded.");
