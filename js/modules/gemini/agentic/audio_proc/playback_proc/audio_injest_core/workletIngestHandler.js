/**
 * workletIngestHandler.js
 * Handles sending audio data to the AudioWorklet for playback.
 */

window.AudioIngestCore = window.AudioIngestCore || {};

window.AudioIngestCore.WorkletIngestHandler = {
    playViaWorklet: async function (arrayBuffer, context) {
        try {
            // Convert to float32 data
            if (typeof convertPCM16LEToFloat32 === 'function' && window.workletNode) {
                const float32Data = convertPCM16LEToFloat32(arrayBuffer);
                console.log("Converted to float32, length:", float32Data.length);

                // postMessage(..., [buffer]) detaches the transferred ArrayBuffer on success.
                // Preserve the resend copy before that transfer so recovery cannot cache a neutered chunk.
                const cacheCopy = new Float32Array(float32Data);

                // Prepare a monotonic sequence id but only commit it after a successful post
                const nextSeq = (window._workletSeq || 0) + 1;

                // Send an object payload with sequence and final flags. Use transferable buffer when possible.
                const payload = { type: 'audio', seq: nextSeq, final: false, data: float32Data };
                // Ensure we have a resend cache for recent chunks
                window._workletCache = window._workletCache || {};
                // Keep cache size modest
                const CACHE_MAX = 16;

                // Attempt to send with retries to avoid transient failures that create sequence gaps
                const maxAttempts = 3;
                let attempt = 0;
                let sent = false;
                let lastErr = null;
                while (attempt < maxAttempts && !sent) {
                    attempt++;
                    try {
                        // Prefer transfer where supported
                        try {
                            window.workletNode.port.postMessage(payload, [float32Data.buffer]);
                            sent = true;
                            window._workletSeq = nextSeq;
                            console.log("Audio data sent to worklet node (transfer), seq:", nextSeq, "attempt:", attempt);
                            break;
                        } catch (e) {
                            // If transfer fails, fall back to non-transfer
                            console.warn("postMessage with transfer failed on attempt", attempt, e);
                            window.workletNode.port.postMessage(payload);
                            sent = true;
                            window._workletSeq = nextSeq;
                            console.log("Audio data sent to worklet node (non-transfer), seq:", nextSeq, "attempt:", attempt);
                            break;
                        }
                    } catch (err) {
                        lastErr = err;
                        console.error("Attempt", attempt, "failed to post audio to worklet node:", err);
                        // small backoff before retrying
                        await new Promise(r => setTimeout(r, 30 * attempt));
                    }
                }

                if (!sent) {
                    console.error('Failed to deliver audio chunk to worklet node after attempts', maxAttempts, lastErr);
                    throw new Error('Failed to deliver audio chunk to worklet node');
                }

                // Cache the preserved copy for potential resend requests from the worklet.
                try {
                    window._workletCache[nextSeq] = cacheCopy;
                    // Trim cache
                    const keys = Object.keys(window._workletCache).map(k=>parseInt(k)).sort((a,b)=>a-b);
                    while (keys.length > CACHE_MAX) {
                        const remove = keys.shift();
                        delete window._workletCache[remove];
                    }
                } catch (e) {
                    console.warn('Failed to cache audio chunk for resend:', e);
                }

                // Ensure we have a listener for worklet requests
                if (!window._workletCacheListenerAttached && window.workletNode) {
                    window._workletCacheListenerAttached = true;
                    window.workletNode.port.onmessage = (evt) => {
                        const m = evt.data;
                        if (m && m.type === 'requestMissing' && Array.isArray(m.seq)) {
                            // resend requested sequences if available
                            m.seq.forEach(s => {
                                const cached = window._workletCache && window._workletCache[s];
                                if (cached) {
                                    try {
                                        const resend = new Float32Array(cached);
                                        window.workletNode.port.postMessage({ type: 'audio', seq: s, final: false, data: resend }, [resend.buffer]);
                                        console.log('Resent cached seq', s);
                                    } catch (err) {
                                        try {
                                            const resend = new Float32Array(cached);
                                            window.workletNode.port.postMessage({ type: 'audio', seq: s, final: false, data: resend });
                                            console.log('Resent cached seq (no transfer)', s);
                                        } catch (err2) {
                                            console.error('Failed to resend cached seq', s, err2);
                                        }
                                    }
                                } else {
                                    console.warn('No cached data for requested seq', s);
                                }
                            });
                        }
                    };
                }
            } else {
                throw new Error("Dependencies missing for worklet playback (convertPCM16LEToFloat32 or workletNode)");
            }
        } catch (e) {
            console.error("Error with worklet playback, trying fallback:", e);
            // If worklet fails, try fallback strategy within general ingestion logic
            // But here we attempt to set fallback mode if possible
            if (context && !context.usingFallback) {
                // Set up fallback if needed
                const gainNode = context.createGain();
                gainNode.gain.value = 1.0;
                gainNode.connect(context.destination);
                context.gainNode = gainNode;
                context.usingFallback = true;

                // Try fallback immediately
                if (typeof playAudioWithFallbackMethod === 'function') {
                    playAudioWithFallbackMethod(arrayBuffer);
                }
            } else if (context && context.usingFallback && typeof playAudioWithFallbackMethod === 'function') {
                playAudioWithFallbackMethod(arrayBuffer);
            }
        }
    }
};

console.log("workletIngestHandler.js loaded.");
