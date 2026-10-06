window.EveWorldBookNarrationGemini = window.EveWorldBookNarrationGemini || {};

(function (transport) {
    'use strict';
    if (transport.ready) return;

    const WS_URL = 'ws://127.0.0.1:9085';
    const MODEL = 'gemini-3.1-flash-live-preview';
    const FIRST_AUDIO_TIMEOUT_MS = 18000;
    const IDLE_CLOSE_MS = 6000;
    const MIN_AUDIO_CHUNK_BYTES = 64;
    let socket = null;
    let connectPromise = null;
    let socketVoice = '';
    let pendingTurn = null;
    let resolvedModel = MODEL;
    let idleCloseTimer = 0;

    const audio = () => window.EveWorldBookNarrationAudio;

    function setupMessage(config) {
        const voice = config.geminiVoice || 'Aoede';
        const instruction = config.strictVerbatim === false
            ? 'Narrate the supplied prose naturally without commentary, headings, acknowledgments, summaries, or invented facts.'
            : 'Read supplied prose aloud exactly and naturally. Do not add commentary, headings, acknowledgments, summaries, or invented words. Preserve names and punctuation. Return audio only.';
        return {
            sessionRole: 'world_book_narration',
            model: MODEL,
            responseTimeout: 90,
            sequentialAudioPlay: true,
            // Narration already owns the source text, so asking the Live session to transcribe its
            // own audio wastes work/quota and can keep the second Live slot busy longer than needed.
            inlineTranscriptionMode: false,
            outputTranscriptionEnabled: false,
            setup: {
                contents: [{ parts: [{ text: `You are World Book's narrator speaking with the voice of ${voice}.` }] }],
                tools: [],
                systemInstruction: { parts: [{ text: instruction }] },
                generationConfig: {
                    temperature: 0.2,
                    topK: 1,
                    topP: 0.8,
                    candidateCount: 1,
                    maxOutputTokens: 8192,
                    responseModalities: ['AUDIO']
                },
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: voice, speakingRate: 1, pitch: 0 } }
                }
            }
        };
    }

    function clearIdleClose() {
        if (!idleCloseTimer) return;
        window.clearTimeout(idleCloseTimer);
        idleCloseTimer = 0;
    }

    function clearTurnTimers(turn) {
        if (!turn) return;
        window.clearTimeout(turn.timeout);
        window.clearTimeout(turn.firstAudioTimeout);
    }

    function rejectPending(reason) {
        const turn = pendingTurn;
        if (!turn) return;
        pendingTurn = null;
        clearTurnTimers(turn);
        turn.reject(reason instanceof Error ? reason : new Error(String(reason || 'Narration stopped.')));
    }

    function close(reason = 'Narration stopped.') {
        clearIdleClose();
        rejectPending(reason);
        const active = socket;
        socket = null;
        connectPromise = null;
        socketVoice = '';
        try { active?.close?.(); } catch (_error) {}
    }

    function scheduleIdleClose() {
        clearIdleClose();
        idleCloseTimer = window.setTimeout(() => {
            idleCloseTimer = 0;
            if (!pendingTurn) close('Narration session released after idle.');
        }, IDLE_CLOSE_MS);
    }

    function connect(config) {
        const voice = config.geminiVoice || 'Aoede';
        clearIdleClose();
        if (socket?.readyState === WebSocket.OPEN && socketVoice === voice) return Promise.resolve();
        if (connectPromise && socketVoice === voice) return connectPromise;
        close('Narration voice changed.');
        socketVoice = voice;
        connectPromise = new Promise((resolve, reject) => {
            const next = new WebSocket(WS_URL);
            const timeout = window.setTimeout(() => {
                try { next.close(); } catch (_error) {}
                reject(new Error('Gemini narration server did not answer.'));
            }, 12000);
            next.onopen = () => {
                next.send(JSON.stringify(setupMessage(config)));
                window.clearTimeout(timeout);
                resolve();
            };
            next.onmessage = onMessage;
            next.onerror = () => {
                window.clearTimeout(timeout);
                reject(new Error('Gemini narration server is offline.'));
            };
            next.onclose = () => {
                window.clearTimeout(timeout);
                if (socket === next) socket = null;
                connectPromise = null;
                socketVoice = '';
                if (pendingTurn) rejectPending('Gemini narration connection closed.');
            };
            socket = next;
        }).catch(error => {
            connectPromise = null;
            if (socket && socket.readyState !== WebSocket.OPEN) {
                try { socket.close(); } catch (_error) {}
                socket = null;
                socketVoice = '';
            }
            throw error;
        });
        return connectPromise;
    }

    function mergeTranscript(current, incoming) {
        const chunk = String(incoming || '').trim();
        if (!chunk) return current;
        if (!current || chunk.startsWith(current)) return chunk;
        if (current.endsWith(chunk)) return current;
        return `${current} ${chunk}`.trim();
    }

    function onMessage(event) {
        let data;
        try { data = JSON.parse(event.data); }
        catch (_error) { return; }
        if (data.type === 'session_ready' && data.model) resolvedModel = String(data.model);
        if (data.type === 'model_migrated' && data.to) resolvedModel = String(data.to);
        const turn = pendingTurn;
        if (!turn) return;
        if (data.audio) {
            const bytes = audio().base64Bytes(data.audio);
            // Gemini sometimes emits a 2-byte PCM sentinel/empty frame before useful audio. It
            // must not count as "audio started" or keep Reader waiting through quota exhaustion.
            if (bytes.byteLength >= MIN_AUDIO_CHUNK_BYTES) {
                if (!turn.receivedMeaningfulAudio) {
                    turn.receivedMeaningfulAudio = true;
                    window.clearTimeout(turn.firstAudioTimeout);
                    turn.firstAudioTimeout = 0;
                }
                const fingerprint = audio().fingerprint(bytes);
                if (fingerprint === turn.lastFingerprint) turn.duplicateChunks += 1;
                else {
                    turn.lastFingerprint = fingerprint;
                    turn.chunks.push(bytes);
                    turn.rawBytes += bytes.byteLength;
                    turn.stream?.push(bytes, audio().SAMPLE_RATE);
                }
            }
        }
        if (data.type === 'transcription') {
            turn.spokenText = mergeTranscript(turn.spokenText, data.text);
        }
        if (data.type === 'turn_complete') finish();
        if (data.is_error || data.type === 'error') {
            finish(new Error(data.text || data.message || 'Gemini narration failed.'));
        }
    }

    function finish(error) {
        const turn = pendingTurn;
        if (!turn) return;
        pendingTurn = null;
        clearTurnTimers(turn);
        if (error) {
            turn.reject(error);
            // A quota/resource/deadline failure should never leave the narrator occupying one of
            // the two Gemini Live session slots. Browser TTS fallback can begin immediately.
            window.setTimeout(() => close('Gemini narration turn failed.'), 0);
            return;
        }
        if (!turn.chunks.length) {
            turn.reject(new Error('Gemini returned no narration audio.'));
            window.setTimeout(() => close('Gemini narration returned no audio.'), 0);
            return;
        }
        const joined = audio().joinBytes(turn.chunks);
        const trimmed = audio().trimPcm(joined, { leading: true, trailing: true });
        if (!trimmed.byteLength) {
            turn.reject(new Error('Gemini narration contained only digital silence.'));
            window.setTimeout(() => close('Gemini narration contained only silence.'), 0);
            return;
        }
        const streamResult = turn.stream?.finish() || { started: false, duplicateChunks: 0, scheduledSeconds: 0 };
        turn.resolve({
            pcm: trimmed.buffer.slice(trimmed.byteOffset, trimmed.byteOffset + trimmed.byteLength),
            sampleRate: audio().SAMPLE_RATE,
            spokenText: turn.spokenText,
            model: resolvedModel,
            durationSec: trimmed.byteLength / 2 / audio().SAMPLE_RATE,
            rawDurationSec: turn.rawBytes / 2 / audio().SAMPLE_RATE,
            duplicateChunks: turn.duplicateChunks + Number(streamResult.duplicateChunks || 0),
            streamed: streamResult.started,
            streamedDurationSec: streamResult.scheduledSeconds || 0
        });
        // Reuse the socket for immediate next/previous passage clicks, but don't reserve a Gemini
        // Live slot for an idle Reader Library indefinitely.
        scheduleIdleClose();
    }

    async function synthesize(text, config, options = {}) {
        if (pendingTurn) throw new Error('Gemini is already narrating another passage.');
        clearIdleClose();
        await connect(config);
        if (options.isCancelled?.()) throw new Error('Narration stopped.');
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => finish(new Error('Gemini narration timed out.')), 90000);
            const firstAudioTimeout = window.setTimeout(() => {
                finish(new Error('Gemini narration did not start audio in time.'));
            }, FIRST_AUDIO_TIMEOUT_MS);
            pendingTurn = {
                resolve,
                reject,
                chunks: [],
                rawBytes: 0,
                spokenText: '',
                timeout,
                firstAudioTimeout,
                receivedMeaningfulAudio: false,
                stream: options.stream || null,
                duplicateChunks: 0,
                lastFingerprint: ''
            };
            socket.send(JSON.stringify({
                source: 'world_book_narration',
                realtime_input: { media_chunks: [{ mime_type: 'text/plain', data: text }] }
            }));
        });
    }

    Object.assign(transport, {
        ready: true,
        synthesize,
        close,
        cancel: rejectPending,
        getConnectionState: () => socket?.readyState ?? (typeof WebSocket === 'function' ? WebSocket.CLOSED : 3),
        getModel: () => resolvedModel
    });
})(window.EveWorldBookNarrationGemini);
