window.EveAudioflixAudioLayers = window.EveAudioflixAudioLayers || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixAudioLayers;
    if (ns.ready) return;

    function createController(deps) {
        const activeLayers = new Map();
        const itemEpochs = new Map();
        let globalEpoch = 0;
        let layerSequence = 0;
        let progressTimer = 0;
        const MAX_LAYERS_PER_ITEM = 12;
        const MAX_LAYERS_TOTAL = 32;

        const itemId = (item) => String(item?.id || item?.url || '');
        const epoch = (id) => Number(itemEpochs.get(id) || 0);
        const isCancelled = (id, itemEpoch, startEpoch) => (
            epoch(id) !== itemEpoch || globalEpoch !== startEpoch
        );
        const now = () => Date.now();
        const durationOf = (record) => {
            const playerDuration = Number(record?.player?.duration);
            if (Number.isFinite(playerDuration) && playerDuration > 0) return playerDuration;
            const knownDuration = Number(record?.duration);
            return Number.isFinite(knownDuration) && knownDuration > 0 ? knownDuration : 0;
        };
        const currentTimeOf = (record, at = now()) => {
            const playerTime = Number(record?.player?.currentTime);
            if (Number.isFinite(playerTime) && playerTime >= 0) return playerTime;
            const elapsed = Math.max(0, (at - Number(record?.startedAt || at)) / 1000);
            const duration = durationOf(record);
            return duration ? Math.min(duration, elapsed) : elapsed;
        };
        const layerSnapshot = (record, at = now()) => {
            const duration = durationOf(record);
            const currentTime = currentTimeOf(record, at);
            return {
                id: record.id,
                sequence: record.sequence,
                itemId: record.itemId,
                title: record.title,
                currentTime,
                duration,
                remaining: duration ? Math.max(0, duration - currentTime) : 0,
                progress: duration ? Math.min(1, currentTime / duration) : 0,
                native: record.native === true
            };
        };
        const itemSnapshot = (id) => (activeLayers.get(String(id || '')) || [])
            .map(record => layerSnapshot(record));

        function emit(id) {
            const detail = { itemId: String(id || ''), voices: itemSnapshot(id) };
            if (typeof deps.dispatch === 'function') deps.dispatch('eve:audioflix-layer-voices', detail);
            else if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
                window.dispatchEvent(new window.CustomEvent('eve:audioflix-layer-voices', { detail }));
            }
            return detail;
        }

        function stopProgressTimer() {
            if (progressTimer && typeof window.clearInterval === 'function') window.clearInterval(progressTimer);
            progressTimer = 0;
        }

        function removeLayer(id, record) {
            const layers = activeLayers.get(id);
            if (!layers) return;
            const index = layers.indexOf(record);
            if (index >= 0) layers.splice(index, 1);
            if (!layers.length) activeLayers.delete(id);
            emit(id);
            if (!activeLayers.size) stopProgressTimer();
        }

        function progressTick() {
            const at = now();
            activeLayers.forEach((records, id) => {
                records.slice().forEach(record => {
                    const duration = durationOf(record);
                    if (record.native && duration && currentTimeOf(record, at) >= duration) {
                        removeLayer(id, record);
                    }
                });
                if (activeLayers.has(id)) emit(id);
            });
            if (!activeLayers.size) stopProgressTimer();
        }

        function ensureProgressTimer() {
            if (!progressTimer && typeof window.setInterval === 'function') {
                progressTimer = window.setInterval(progressTick, 180);
            }
        }

        function makeRecord(id, item, values = {}) {
            layerSequence += 1;
            return {
                id: `${id}::layer:${layerSequence}`,
                sequence: layerSequence,
                itemId: id,
                title: String(item?.title || 'Layered sound'),
                startedAt: now(),
                duration: Number(values.duration ?? item?.duration) || 0,
                ...values
            };
        }

        function totalLayers() {
            let total = 0;
            activeLayers.forEach((records) => { total += records.length; });
            return total;
        }

        function evictLayer(id, record) {
            const result = stopLayer(record);
            if (result?.then) Promise.resolve(result).catch(() => false);
            removeLayer(id, record);
        }

        function pruneForAdd(id) {
            const own = activeLayers.get(id) || [];
            while (own.length >= MAX_LAYERS_PER_ITEM) evictLayer(id, own[0]);
            while (totalLayers() >= MAX_LAYERS_TOTAL) {
                let oldestId = '', oldest = null;
                activeLayers.forEach((records, key) => records.forEach((record) => {
                    if (!oldest || Number(record.startedAt || 0) < Number(oldest.startedAt || 0)) {
                        oldest = record; oldestId = key;
                    }
                }));
                if (!oldest) break;
                evictLayer(oldestId, oldest);
            }
        }

        function addLayer(id, record) {
            pruneForAdd(id);
            if (!activeLayers.has(id)) activeLayers.set(id, []);
            activeLayers.get(id).push(record);
            ensureProgressTimer();
            emit(id);
            return record;
        }

        async function cancelStartedUrl(id) {
            try { await deps.stopUrlPlayback?.(id); } catch {}
        }

        async function layerPlay(item) {
            if (!item?.url) return false;
            let safeItem = typeof item === 'object' ? { ...item } : { url: item };
            const id = itemId(safeItem);
            const itemStartEpoch = epoch(id);
            const globalStartEpoch = globalEpoch;
            const cancelled = () => isCancelled(id, itemStartEpoch, globalStartEpoch);

            if (deps.shouldPreferUrl?.(safeItem)) {
                const played = await deps.playUrlItem(safeItem);
                if (!cancelled()) return played;
                await cancelStartedUrl(id);
                return false;
            }
            if (window.EveAudioflixAudioSource?.needsResolution?.(safeItem.url)) {
                try {
                    safeItem = await window.EveAudioflixAudioSource.resolveItem(safeItem);
                } catch (error) {
                    if (cancelled()) return false;
                    if (deps.canPlayUrl?.(safeItem)) {
                        const played = await deps.playUrlItem(safeItem);
                        if (!cancelled()) return played;
                        await cancelStartedUrl(id);
                        return false;
                    }
                    console.warn('[Audioflix] Failed to resolve stream URL for layer:', error);
                    return false;
                }
            }
            if (cancelled()) return false;

            if (await deps.tryNativePlayback(safeItem)) {
                if (!cancelled()) {
                    addLayer(id, makeRecord(id, safeItem, {
                        native: true,
                        stop: () => deps.stopNativeItem?.(id, safeItem)
                    }));
                    return true;
                }
                await deps.stopNativeItem?.(id);
                return false;
            }
            if (window.EveAudioflixNative?.shouldSuppressBrowserPlayback?.()) {
                try {
                    const buffer = await deps.getDecodedBuffer(safeItem.url);
                    if (cancelled()) return false;
                    const record = makeRecord(id, safeItem, {
                        native: true,
                        duration: Number(buffer.duration) || 0
                    });
                    const ok = await window.EveAudioflixNative.playVoice(deps.encodeBufferToBase64(buffer), {
                        sampleRate: buffer.sampleRate,
                        channels: 1,
                        volume: safeItem.volume ?? 1,
                        voiceId: record.id
                    });
                    if (cancelled()) {
                        if (ok) await window.EveAudioflixNative?.clearVoices?.(record.id);
                        return false;
                    }
                    if (ok) {
                        window.EveAudioflixAudio?.getWaveformController?.()?.playBufferWaveform?.(buffer);
                        record.stop = () => window.EveAudioflixNative?.clearVoices?.(record.id);
                        addLayer(id, record);
                        return true;
                    }
                } catch (error) {
                    console.warn('[Audioflix] native voice failed for layer, falling back:', error);
                }
            }

            const player = new Audio();
            player.crossOrigin = 'anonymous';
            player.src = safeItem.url;
            player.loop = false;
            player.volume = window.EveAudioflixState.normalizeVolume(safeItem.volume, 1);
            window.EveAudioflixAudio?.getWaveformController?.()?.attachPlayer?.(player);
            const sinkId = deps.state().preferredSinkId;
            if (sinkId && typeof player.setSinkId === 'function') {
                try { await player.setSinkId(sinkId); } catch {}
            }
            if (cancelled()) return false;
            const record = makeRecord(id, safeItem, {
                player,
                stop() {
                    player.pause();
                    player.currentTime = 0;
                }
            });
            addLayer(id, record);
            player.addEventListener('loadedmetadata', () => emit(id));
            player.addEventListener('durationchange', () => emit(id));
            player.addEventListener('timeupdate', () => emit(id));
            player.addEventListener('ended', () => removeLayer(id, record));
            try {
                await player.play();
            } catch (error) {
                removeLayer(id, record);
                throw error;
            }
            if (cancelled()) {
                stopLayer(record);
                removeLayer(id, record);
                return false;
            }
            return true;
        }

        function stopLayer(layer) {
            try {
                if (typeof layer?.stop === 'function') return layer.stop();
                layer?.player?.pause?.();
                if (layer?.player) layer.player.currentTime = 0;
            } catch {}
            return null;
        }

        function stopItemLayers(value) {
            const id = String(value || '');
            itemEpochs.set(id, epoch(id) + 1);
            const layers = activeLayers.get(id) || [];
            const pending = layers.map(stopLayer).filter(result => result?.then);
            activeLayers.delete(id);
            emit(id);
            if (!activeLayers.size) stopProgressTimer();
            return pending;
        }

        function stopAll() {
            globalEpoch += 1;
            itemEpochs.clear();
            const ids = [...activeLayers.keys()];
            const pending = [];
            activeLayers.forEach(layers => layers.forEach(layer => {
                const result = stopLayer(layer);
                if (result?.then) pending.push(result);
            }));
            activeLayers.clear();
            stopProgressTimer();
            ids.forEach(emit);
            return pending;
        }

        function updateVolume(value, volume) {
            const id = String(value || '');
            const safe = Math.max(0, Math.min(1, Number(volume || 0)));
            (activeLayers.get(id) || []).forEach(layer => {
                if (layer?.player && typeof layer.player.volume !== 'undefined') layer.player.volume = safe;
                if (layer?.native) window.EveAudioflixNative?.setVoiceVolume?.(layer.id, safe);
            });
        }

        return { layerPlay, stopItemLayers, stopAll, updateVolume, getSnapshot: itemSnapshot };
    }

    Object.assign(ns, { ready: true, createController });
})();
