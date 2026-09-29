window.EveWorldBookNarrationGemini = window.EveWorldBookNarrationGemini || {};

(function (transport) {
    'use strict';
    if (transport.ready) return;

    const WS_URL = 'ws://127.0.0.1:9085';
    const MODEL = 'gemini-3.1-flash-live-preview';
    let socket = null;
    let connectPromise = null;
    let socketVoice = '';
    let pendingTurn = null;
    let resolvedModel = MODEL;

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
            inlineTranscriptionMode: true,
            outputTranscriptionEnabled: true,
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

    function rejectPending(reason) {
        const turn = pendingTurn;
        if (!turn) return;
        pendingTurn = null;
        window.clearTimeout(turn.timeout);
        turn.reject(reason instanceof Error ? reason : new Error(String(reason || 'Narration stopped.')));
    }

    function close(reason = 'Narration stopped.') {
        rejectPending(reason);
        const active = socket;
        socket = null;
        connectPromise = null;
        socketVoice = '';
        try { active?.close?.(); } catch (_error) {}
    }

    function connect(config) {
        const voice = config.geminiVoice || 'Aoede';
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
            next.onerror = () => reject(new Error('Gemini narration server is offline.'));
            next.onclose = () => {
                if (socket === next) socket = null;
                connectPromise = null;
                if (pendingTurn) rejectPending('Gemini narration connection closed.');
            };
            socket = next;
        }).catch(error => {
            connectPromise = null;
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
            const fingerprint = audio().fingerprint(bytes);
            if (fingerprint === turn.lastFingerprint) turn.duplicateChunks += 1;
            else {
                turn.lastFingerprint = fingerprint;
                turn.chunks.push(bytes);
                turn.rawBytes += bytes.byteLength;
                turn.stream?.push(bytes, audio().SAMPLE_RATE);
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
        window.clearTimeout(turn.timeout);
        if (error) {
            turn.reject(error);
            return;
        }
        if (!turn.chunks.length) {
            turn.reject(new Error('Gemini returned no narration audio.'));
            return;
        }
        const joined = audio().joinBytes(turn.chunks);
        const trimmed = audio().trimPcm(joined, { leading: true, trailing: true });
        if (!trimmed.byteLength) {
            turn.reject(new Error('Gemini narration contained only digital silence.'));
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
    }

    async function synthesize(text, config, options = {}) {
        if (pendingTurn) throw new Error('Gemini is already narrating another passage.');
        await connect(config);
        if (options.isCancelled?.()) throw new Error('Narration stopped.');
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => finish(new Error('Gemini narration timed out.')), 90000);
            pendingTurn = {
                resolve,
                reject,
                chunks: [],
                rawBytes: 0,
                spokenText: '',
                timeout,
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
