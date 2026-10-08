// Native buffered playback engine for Audioflix (soundboard clips as mixable voices, and the
// buffered stream lane). Split out of audioflix.audio.js to keep it under the project line cap.
//
// The native playback STATE (controller, buffer, mode, paused position, generation, stream
// volume) still lives in audio.js because getPlaybackState/pause/seek read it directly there;
// this module reaches it through a `runtime` accessor bag (same pattern as the output
// controller's runtime). `generation` guards against a late callback from a superseded play.
window.EveAudioflixAudioNative = window.EveAudioflixAudioNative || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixAudioNative;
    if (ns.ready) return;

    ns.createController = function createController(deps) {
        const rt = deps.runtime;
        const dispatch = deps.dispatch;
        const getCurrentItem = deps.getCurrentItem;
        const encodeBufferToBase64 = deps.encodeBufferToBase64;
        const normalizeVolume = (value, fallback) => window.EveAudioflixState.normalizeVolume(value, fallback);

        function nativeProgress(currentTime, duration, paused = false) {
            dispatch('eve:audioflix-progress', {
                item: getCurrentItem(),
                currentTime: Math.max(0, Number(currentTime || 0)),
                duration: Math.max(0, Number(duration || 0)),
                paused,
                native: true
            });
        }

        function finishNative(generation) {
            if (generation !== rt.generation) return;
            const duration = Number(rt.buffer?.duration || 0) || 0;
            rt.controller = null;
            rt.mode = '';
            rt.buffer = null;
            rt.pausedAt = 0;
            rt.lastStatus = 'Ended';
            dispatch('eve:audioflix-playback', { status: rt.lastStatus, item: getCurrentItem(), native: true });
            nativeProgress(duration, duration, true);
        }

        async function startNativeBuffer(buffer, item, startAt = 0, requestedMode = '') {
            const mode = requestedMode || (item.type === 'sound' ? 'voice' : 'stream');
            const generation = rt.generation = rt.generation + 1;
            rt.buffer = buffer;
            rt.mode = mode;
            rt.pausedAt = 0;
            rt.streamVolume = window.EveAudioflixOutputPort?.effective?.(item.volume) ?? normalizeVolume(item.volume, 1);

            const timelineOptions = {
                duration: buffer.duration,
                startAt,
                onProgress: (current, duration) => generation === rt.generation && nativeProgress(current, duration),
                onEnded: () => finishNative(generation)
            };

            if (mode === 'voice') {
                const accepted = await window.EveAudioflixNative?.playVoice?.(encodeBufferToBase64(buffer, startAt), {
                    sampleRate: buffer.sampleRate,
                    channels: 1,
                    volume: rt.streamVolume,
                    voiceId: 'singleton-main',
                    replace: true
                });
                if (accepted !== true) throw new Error('Native bridge unreachable for voice playback');
                deps.playBufferWaveform?.(buffer, startAt);
                rt.controller = window.EveAudioflixAudioBridge?.createTimeline?.(timelineOptions) || null;
                return true;
            }

            const controller = window.EveAudioflixAudioBridge?.createStream?.({
                buffer,
                startAt,
                volume: rt.streamVolume,
                sendChunk: (payload, detail) => window.EveAudioflixNative?.sendGeminiChunk?.(payload, detail),
                stopRemote: () => window.EveAudioflixNative?.stopStream?.(),
                onProgress: timelineOptions.onProgress,
                onEnded: timelineOptions.onEnded,
                onError(error) {
                    if (generation !== rt.generation) return;
                    rt.controller = null;
                    rt.mode = '';
                    rt.buffer = null;
                    rt.lastStatus = error?.message || 'Native stream failed';
                    dispatch('eve:audioflix-playback', { status: rt.lastStatus, item: getCurrentItem(), native: true, error: true });
                }
            });
            rt.controller = controller;
            if (!controller || await controller.ready !== true) throw new Error('Native stream did not start.');
            return true;
        }

        async function stopNativePlayback(keepPosition = false) {
            deps.stopWaveform?.();
            if (!rt.mode) return;
            const mode = rt.mode;
            const controller = rt.controller;
            const position = controller?.currentTime?.() ?? rt.pausedAt;
            rt.generation = rt.generation + 1;
            rt.controller = null;
            if (mode === 'stream') await controller?.stop?.({ clearRemote: true });
            else {
                controller?.stop?.();
                await window.EveAudioflixNative?.clearVoices?.('singleton-main');
            }
            if (keepPosition) rt.pausedAt = position;
            else {
                rt.pausedAt = 0;
                rt.mode = '';
                rt.buffer = null;
            }
        }

        return { nativeProgress, finishNative, startNativeBuffer, stopNativePlayback };
    };

    ns.ready = true;
})();
