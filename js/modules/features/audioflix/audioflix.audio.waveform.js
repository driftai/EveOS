window.EveAudioflixAudioWaveform = window.EveAudioflixAudioWaveform || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixAudioWaveform;
    if (ns.ready) return;

    function createController(ensureAudio) {
        let context = null;
        let source = null;
        let analyser = null;
        let outputGain = null;
        let captureNode = null;
        let captureSink = null;
        let bufferSource = null;
        let bufferAnalyser = null;
        let bufferSink = null;
        let onFrames = null;
        let workletModule = null;
        let canvas = null;
        let canvasContext = null;
        let animationFrame = 0;
        const speakerMuteOwners = new Set();
        // Which players already have our transport listeners. A WeakSet instead of a data-*
        // attribute so this works for anything event-capable, not just DOM elements — attachPlayer
        // sits on the playItem path, where a throw costs the user all audio, not just the drawing.
        const wiredPlayers = new WeakSet();

        let activePlayer = null;
        const connectedSources = new WeakMap();

        function ensureGraph(overridePlayer) {
            const player = overridePlayer || activePlayer || ensureAudio();
            if (!context) {
                const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextCtor) return null;
                context = new AudioContextCtor();
                analyser = context.createAnalyser();
                analyser.fftSize = 1024;
                outputGain = context.createGain();
                analyser.connect(outputGain);
                outputGain.connect(context.destination);
            }
            if (player && !connectedSources.has(player)) {
                try {
                    const srcNode = context.createMediaElementSource(player);
                    srcNode.connect(analyser);
                    connectedSources.set(player, srcNode);
                    if (!source) source = srcNode;
                } catch (e) {
                    console.warn('[Audioflix] could not connect media element source:', e);
                }
            }
            return context;
        }

        // The graph can legitimately fail to build (no AudioContext, a non-media element, a source
        // already claimed elsewhere). Never let that throw into playback — callers fall back.
        function safeGraph(overridePlayer) {
            try { return ensureGraph(overridePlayer); } catch (error) {
                console.warn('[Audioflix] audio graph unavailable:', error);
                return null;
            }
        }

        // Silence the browser speakers without pausing playback (native route owns the sound).
        function applySpeakerMute() {
            const ctx = safeGraph();
            if (!ctx || !outputGain) return false;
            outputGain.gain.value = speakerMuteOwners.size ? 0 : 1;
            return true;
        }

        function setSpeakerMuted(muted) {
            if (muted) speakerMuteOwners.add('legacy-route');
            else speakerMuteOwners.delete('legacy-route');
            return applySpeakerMute();
        }

        function acquireSpeakerMute(owner) {
            const key = String(owner || 'anonymous-route');
            speakerMuteOwners.add(key);
            applySpeakerMute();
            let released = false;
            return () => {
                if (released) return;
                released = true;
                speakerMuteOwners.delete(key);
                applySpeakerMute();
            };
        }

        function teardownTap() {
            if (captureNode) {
                captureNode.onaudioprocess = null;
                if (captureNode.port) {
                    try { captureNode.port.postMessage({ command: 'stop' }); } catch (error) { /* gone */ }
                    captureNode.port.onmessage = null;
                }
                try { captureNode.disconnect(); } catch (error) { /* already detached */ }
                captureNode = null;
            }
            if (captureSink) {
                try { captureSink.disconnect(); } catch (error) { /* already detached */ }
                captureSink = null;
            }
        }

        // A data: URL built from the inlined source is the only form addModule accepts on a
        // file:// page (a file:// URL and a blob: URL both AbortError there), and it works
        // identically on http — so there is no protocol branching left.
        function workletModuleUrls() {
            const src = window.EveAudioflixCaptureProcessorSrc;
            return src ? ['data:application/javascript,' + encodeURIComponent(src)] : [];
        }

        // Prefer an AudioWorklet tap: it runs on the audio thread, so main-thread jank cannot make
        // it deliver late/short frames (the ScriptProcessor weakness heard as blips). Only a
        // SUCCESSFUL load is cached — a failure before the bridge base is known must not permanently
        // pin us to the fallback tap once the server origin becomes available.
        function ensureWorkletModule(ctx) {
            if (!ctx?.audioWorklet?.addModule) return null;
            if (workletModule) return workletModule;
            let lastError = null;
            const attempt = (async () => {
                for (const url of workletModuleUrls()) {
                    try { await ctx.audioWorklet.addModule(url); return true; }
                    catch (error) { lastError = error; }
                }
                console.warn('[Audioflix] capture worklet unavailable, using fallback tap:', lastError);
                return false;
            })();
            attempt.then((ok) => { workletModule = ok ? Promise.resolve(true) : null; });
            return attempt;
        }

        function attachWorkletTap(ctx) {
            captureNode = new AudioWorkletNode(ctx, 'audioflix-capture-processor', {
                numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
                processorOptions: { blockSize: 4096 }
            });
            captureNode.port.onmessage = (event) => {
                const block = event.data;
                if (!block || !block.length) return;
                // Shaped like an AudioBuffer input so both tap kinds share one handler.
                onFrames?.({ numberOfChannels: 1, getChannelData: () => block }, ctx.sampleRate);
            };
            captureSink = ctx.createGain();
            captureSink.gain.value = 0;
            analyser.connect(captureNode);
            captureNode.connect(captureSink);
            captureSink.connect(ctx.destination);
        }

        function attachScriptTap(ctx) {
            captureNode = ctx.createScriptProcessor(4096, 2, 2);
            captureSink = ctx.createGain();
            captureSink.gain.value = 0;
            captureNode.onaudioprocess = (event) => onFrames?.(event.inputBuffer, ctx.sampleRate);
            analyser.connect(captureNode);
            captureNode.connect(captureSink);
            captureSink.connect(ctx.destination);
        }

        // Real-time PCM tap on the live player. Lets the native bridge play a track WITHOUT
        // pre-decoding it, which is what made music lag between pressing play and hearing it.
        // Pass null to tear the tap down. Resolves to the context sample rate, or 0 if unavailable.
        async function setFrameTap(handler) {
            const ctx = safeGraph();
            if (!ctx) return 0;
            onFrames = typeof handler === 'function' ? handler : null;
            if (!onFrames) {
                teardownTap();
                return ctx.sampleRate;
            }
            if (captureNode) return ctx.sampleRate;
            const worklet = await ensureWorkletModule(ctx);
            try {
                if (worklet) attachWorkletTap(ctx);
                else if (typeof ctx.createScriptProcessor === 'function') attachScriptTap(ctx);
                else return 0;
            } catch (error) {
                console.warn('[Audioflix] live PCM tap unavailable:', error);
                teardownTap();
                onFrames = null;
                return 0;
            }
            return ctx.sampleRate;
        }

        // A separate stream tap leaves speakers, waveform, and native PCM ownership intact.
        async function createLiveTap() {
            const ctx = safeGraph();
            if (!ctx || !analyser) throw new Error('Audioflix audio capture is unavailable.');
            await ctx.resume();
            const destination = ctx.createMediaStreamDestination();
            analyser.connect(destination);
            let released = false;
            return { stream: destination.stream, release() {
                if (released) return;
                released = true;
                try { analyser.disconnect(destination); } catch {}
                destination.stream.getTracks().forEach(track => track.stop());
            } };
        }

        function fitCanvas() {
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const dpr = Math.max(1, window.devicePixelRatio || 1);
            const width = Math.max(240, Math.floor(rect.width * dpr));
            const height = Math.max(64, Math.floor(rect.height * dpr));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
            canvasContext = canvas.getContext('2d');
        }

        function draw() {
            const visualAnalyser = bufferAnalyser || analyser;
            if (!canvas || !canvasContext || !visualAnalyser) {
                animationFrame = 0;
                return;
            }
            fitCanvas();
            const width = canvas.width;
            const height = canvas.height;
            const data = new Uint8Array(visualAnalyser.frequencyBinCount);
            visualAnalyser.getByteTimeDomainData(data);
            canvasContext.clearRect(0, 0, width, height);
            const gradient = canvasContext.createLinearGradient(0, 0, width, 0);
            gradient.addColorStop(0, '#00d4ff');
            gradient.addColorStop(0.5, '#9cffad');
            gradient.addColorStop(1, '#ffca5f');
            canvasContext.strokeStyle = gradient;
            canvasContext.lineWidth = Math.max(2, width / 420);
            canvasContext.beginPath();
            const slice = width / data.length;
            for (let index = 0; index < data.length; index += 1) {
                const x = index * slice;
                const y = (data[index] / 255) * height;
                if (index === 0) canvasContext.moveTo(x, y);
                else canvasContext.lineTo(x, y);
            }
            canvasContext.stroke();
            animationFrame = window.requestAnimationFrame(draw);
        }

        function stopDrawing() {
            if (animationFrame) window.cancelAnimationFrame(animationFrame);
            animationFrame = 0;
        }

        function releaseBufferWaveform(expectedSource) {
            if (expectedSource && bufferSource !== expectedSource) return;
            const staleSource = bufferSource;
            bufferSource = null;
            if (staleSource) {
                staleSource.onended = null;
                try { staleSource.stop(); } catch (error) { /* already ended */ }
                try { staleSource.disconnect(); } catch (error) { /* already detached */ }
            }
            if (bufferAnalyser) {
                try { bufferAnalyser.disconnect(); } catch (error) { /* already detached */ }
                bufferAnalyser = null;
            }
            if (bufferSink) {
                try { bufferSink.disconnect(); } catch (error) { /* already detached */ }
                bufferSink = null;
            }
        }

        function stop() {
            stopDrawing();
            releaseBufferWaveform();
        }

        function start() {
            try {
                ensureGraph();
                if (context?.state === 'suspended') context.resume();
                stopDrawing();
                draw();
            } catch (error) {
                console.warn('[Audioflix] waveform unavailable for this source:', error);
            }
        }

        function playBufferWaveform(audioBuffer, startAt = 0) {
            if (!audioBuffer) return;
            const ctx = safeGraph();
            if (!ctx || !analyser) return;
            try {
                if (ctx.state === 'suspended') ctx.resume();
                releaseBufferWaveform();
                bufferAnalyser = ctx.createAnalyser();
                bufferAnalyser.fftSize = analyser.fftSize;
                bufferSink = ctx.createGain();
                bufferSink.gain.value = 0;
                bufferAnalyser.connect(bufferSink);
                bufferSink.connect(ctx.destination);

                const nextSource = ctx.createBufferSource();
                bufferSource = nextSource;
                nextSource.buffer = audioBuffer;
                nextSource.connect(bufferAnalyser);
                nextSource.onended = () => {
                    releaseBufferWaveform(nextSource);
                    if (!activePlayer || activePlayer.paused) stopDrawing();
                };
                const duration = Math.max(0, Number(audioBuffer.duration || 0));
                const offset = Math.max(0, Math.min(Number(startAt || 0), Math.max(0, duration - 0.001)));
                nextSource.start(0, offset);
                start();
            } catch (e) {
                releaseBufferWaveform();
                console.warn('[Audioflix] could not play buffer waveform:', e);
            }
        }

        function attachPlayer(player) {
            if (!player) return;
            activePlayer = player;
            ensureGraph(player);
            if (!wiredPlayers.has(player) && typeof player.addEventListener === 'function') {
                wiredPlayers.add(player);
                player.addEventListener('play', () => {
                    activePlayer = player;
                    start();
                });
                ['pause', 'ended', 'error'].forEach((eventName) => {
                    player.addEventListener(eventName, () => {
                        if (activePlayer === player) stop();
                    });
                });
            }
            if (canvas && !animationFrame && !player.paused) start();
        }

        function attach(targetCanvas) {
            canvas = targetCanvas || null;
            if (!canvas) {
                stop();
                return;
            }
            fitCanvas();
            const player = ensureAudio();
            attachPlayer(player);
        }

        return { attach, attachPlayer, playBufferWaveform, start, stop, getContext: ensureGraph, ensureGraph,
            setSpeakerMuted, acquireSpeakerMute, setFrameTap, createLiveTap,
            getActivePlayer: () => activePlayer || ensureAudio() };
    }

    Object.assign(ns, { ready: true, createController });
})();
