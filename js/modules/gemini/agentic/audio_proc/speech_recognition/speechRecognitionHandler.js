
/**
 * SpeechRecognitionHandler.js
 * 
 * Manages client-side speech recognition using the Web Speech API.
 * This provides real-time transcription of user speech without server latency.
 */

if (!window.AudioProcessingControlsAgentic) {
    window.AudioProcessingControlsAgentic = {};
}

// Ensure namespace exists
if (!window.AudioProcessingControlsAgentic.SpeechRecognitionHandler) {
    window.AudioProcessingControlsAgentic.SpeechRecognitionHandler = (function () {

        let recognition = null;
        let isRecognizing = false;
        let finalTranscript = '';
        let interimTranscript = '';
        let pendingFinalText = '';
        let pendingFinalTimer = 0;
        let lastSubmittedText = '';
        let lastSubmittedAt = 0;
        let transcriptionHideTimer = 0;
        let sessionAutoSend = true;
        const transcriptListeners = new Set();
        const TRANSCRIPTION_PREVIEW_MAX_CHARS = 180;

        // Configuration
        const config = {
            lang: 'en-US',
            continuous: true,
            interimResults: true,
            autoSendFinalTranscript: true
        };

        /**
         * Initialize the speech recognition engine
         */
        function initialize() {
            if ('webkitSpeechRecognition' in window) {
                recognition = new webkitSpeechRecognition();
            } else if ('SpeechRecognition' in window) {
                recognition = new SpeechRecognition();
            } else {
                console.warn("[SpeechRecognition] Web Speech API not supported in this browser.");
                return false;
            }

            recognition.continuous = config.continuous;
            recognition.interimResults = config.interimResults;
            recognition.lang = config.lang;

            recognition.onstart = function () {
                isRecognizing = true;
                console.log("[SpeechRecognition] Started");
                // Clear previous transcription UI if needed
            };

            recognition.onerror = function (event) {
                console.error("[SpeechRecognition] Error:", event.error);
                if (event.error === 'no-speech') {
                    // Ignore no-speech errors usually
                }
            };

            recognition.onend = function () {
                isRecognizing = false;
                console.log("[SpeechRecognition] Ended");
                // If we were supposed to be recording, maybe restart? 
                // For now, we rely on the external controller to stop/start.
            };

            recognition.onresult = function (event) {
                interimTranscript = '';
                const finalParts = [];
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        const transcript = normalizeTranscript(event.results[i][0].transcript);
                        if (transcript) finalParts.push(transcript);
                        finalTranscript = normalizeTranscript([finalTranscript, transcript].filter(Boolean).join(' '));
                        console.log("[SpeechRecognition] Final:", finalTranscript);
                        updateTranscriptionUI(transcript, true);
                    } else {
                        interimTranscript += event.results[i][0].transcript;
                    }
                }

                if (interimTranscript) {
                    updateTranscriptionUI(interimTranscript, false);
                }

                if (finalParts.length) {
                    const text = finalParts.join(' ');
                    transcriptListeners.forEach(listener => {
                        try { listener(text); } catch (error) { console.error('[SpeechRecognition] Listener failed:', error); }
                    });
                    queueFinalTranscriptSubmit(text);
                }
            };

            return true;
        }

        /**
         * Start recognition
         */
        function start(options = {}) {
            if (recognition && !isRecognizing) {
                sessionAutoSend = options.autoSend !== false;
                finalTranscript = ''; // Reset for new turn
                interimTranscript = '';
                pendingFinalText = '';
                if (pendingFinalTimer) {
                    clearTimeout(pendingFinalTimer);
                    pendingFinalTimer = 0;
                }
                try {
                    recognition.start();
                } catch (e) {
                    console.warn("[SpeechRecognition] Start failed (maybe already running):", e);
                }
            }
        }

        /**
         * Stop recognition
         */
        function stop() {
            if (recognition && isRecognizing) {
                recognition.stop();
            }
            flushPendingFinalTranscript();
        }

        function normalizeTranscript(text) {
            return String(text || '').replace(/\s+/g, ' ').trim();
        }

        function queueFinalTranscriptSubmit(text) {
            if (!config.autoSendFinalTranscript || !sessionAutoSend) return;
            const normalized = normalizeTranscript(text);
            if (!normalized) return;
            pendingFinalText = normalizeTranscript([pendingFinalText, normalized].filter(Boolean).join(' '));
            if (pendingFinalTimer) clearTimeout(pendingFinalTimer);
            pendingFinalTimer = setTimeout(flushPendingFinalTranscript, 450);
        }

        function flushPendingFinalTranscript() {
            if (pendingFinalTimer) {
                clearTimeout(pendingFinalTimer);
                pendingFinalTimer = 0;
            }
            const text = normalizeTranscript(pendingFinalText);
            pendingFinalText = '';
            if (!text) return;

            const now = Date.now();
            if (text === lastSubmittedText && now - lastSubmittedAt < 3000) return;
            lastSubmittedText = text;
            lastSubmittedAt = now;

            if (typeof window.displayMessage === 'function') {
                window.displayMessage("YOU: " + text);
            }

            // Mode 2 (Text Brain -> Live Voice): route the utterance through the text
            // brain first; it speaks the brain's reply. Falls back to direct-live inside.
            if (window.EveGeminiMode2?.isMode2?.()) {
                window.EveGeminiMode2.relayUserUtterance(text);
                return;
            }

            if (typeof window.sendTextMessage === 'function') {
                window.sendTextMessage(text);
                return;
            }

            const textInput = document.getElementById('textInput');
            if (textInput) {
                textInput.value = text;
            }
            console.warn("[SpeechRecognition] sendTextMessage unavailable; transcript placed in text input.");
        }

        /**
         * Update the UI with the transcribed text.
         * Looks for an element with ID 'transcription-box' or creates/finds a suitable container.
         */
        function updateTranscriptionUI(text, isFinal) {
            // Find the transcription box - assuming standard ID from previous implementation or creating one
            // Ideally this ID should be configurable or standard in the project
            let displayElement = document.getElementById('user-transcription-display');

            if (!displayElement) {
                // If it doesn't exist, try to find the container where it should go
                const container = document.getElementById('chat-input-container') || document.body; // Fallback

                // Construct it if missing (Quick UI fix)
                // In a real app, this should be in the HTML. 
                // We will log for now if missing to guide the next step.
                console.log("[SpeechRecognition] Output:", text);
                return;
            }

            const normalized = normalizeTranscript(text);
            const clipped = normalized.length > TRANSCRIPTION_PREVIEW_MAX_CHARS
                ? `...${normalized.slice(-TRANSCRIPTION_PREVIEW_MAX_CHARS)}`
                : normalized;
            displayElement.textContent = clipped;
            displayElement.title = normalized;
            displayElement.style.display = normalized ? '' : 'none';
            displayElement.style.opacity = isFinal ? '1' : '0.7'; // Visual cue for interim

            if (transcriptionHideTimer) {
                clearTimeout(transcriptionHideTimer);
                transcriptionHideTimer = 0;
            }
            if (isFinal) {
                transcriptionHideTimer = setTimeout(() => {
                    displayElement.style.display = 'none';
                    displayElement.textContent = '';
                    displayElement.title = '';
                    transcriptionHideTimer = 0;
                }, 5000);
            }
        }

        return {
            initialize: initialize,
            start: start,
            stop: stop,
            flushPendingFinalTranscript: flushPendingFinalTranscript,
            subscribe(listener) {
                if (typeof listener !== 'function') return () => {};
                transcriptListeners.add(listener);
                return () => transcriptListeners.delete(listener);
            },
            isSupported: function () { return !!recognition; }
        };

    })();
}
