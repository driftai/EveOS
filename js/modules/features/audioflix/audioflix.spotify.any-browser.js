window.EveAudioflixSpotifyAnyBrowser = window.EveAudioflixSpotifyAnyBrowser || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyAnyBrowser;
    if (ns.ready) return;

    const remote = () => window.EveAudioflixSpotifyRemote;
    const isSpotify = (item) => String(item?.sourceProvider || '').toLowerCase() === 'spotify'
        || !!item?.spotifyUrl
        || /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)/i.test(String(item?.url || item?.originalUrl || ''));
    const spotifyId = (item) => String(item?.spotifyTrackId || item?.spotifyUrl || item?.url || item?.originalUrl || '')
        .match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)?([A-Za-z0-9]{22})(?:[?/#]|$)?/i)?.[1] || '';
    const effectiveGain = (raw) => {
        const safe = Math.max(0, Math.min(1, Number(raw ?? 1)));
        return Math.max(0, Math.min(1, Number(window.EveAudioflixOutputPort?.effective?.(safe) ?? safe));
    };
    const sameItem = (left, right) => String(left?.id || left?.url || '') === String(right?.id || right?.url || '');

    let installed = false;
    let active = false;
    let item = null;
    let playback = { item: null, currentTime: 0, duration: 0, paused: true, provider: 'spotify', browserOnly: true, remoteManaged: true };
    let pollTimer = 0;
    let lastEngineStatus = '';
    let lastCompletionId = '';
    let ended = false;
    let approvalPrompt = null;
    const listeners = new Set();

    function dispatch(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }
    function emitPlayback(status, error = false) {
        dispatch('eve:audioflix-playback', { status, item, provider: 'spotify', browserOnly: true, remoteManaged: true, error });
    }
    function emitProgress() {
        dispatch('eve:audioflix-progress', { ...playback });
    }
    function notify() {
        const value = snapshot();
        listeners.forEach((listener) => { try { listener(value); } catch {} });
    }
    function refreshControls() {
        dispatch('eve:audioflix-spotify-capability', snapshot());
        try { window.EveAudioflix?.render?.(); } catch {}
    }
    function snapshot() {
        return { active, item, playback: { ...playback }, ended, relay: remote()?.snapshot?.() || {} };
    }
    function clearPoll() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = 0;
    }
    function hideApprovalPrompt() {
        try { approvalPrompt?.remove?.(); } catch {}
        approvalPrompt = null;
    }
    function showApprovalPrompt(connection) {
        hideApprovalPrompt();
        const box = document.createElement('div');
        box.dataset.eveSpotifyApproval = 'true';
        Object.assign(box.style, {
            position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483600',
            width: 'min(420px, calc(100vw - 36px))', padding: '16px', borderRadius: '12px',
            border: '1px solid rgba(127,127,127,.45)', background: 'rgba(20,20,20,.96)', color: '#fff',
            boxShadow: '0 12px 40px rgba(0,0,0,.35)', font: '14px system-ui,sans-serif'
        });
        const title = document.createElement('strong');
        title.textContent = 'Connect this EveOS file tab to Spotify';
        const copy = document.createElement('div');
        copy.style.margin = '8px 0 12px';
        copy.textContent = `Pairing code ${connection.code || '------'}. Confirm the same code in the trusted localhost approval window.`;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Open approval window';
        button.addEventListener('click', () => {
            if (!remote()?.openApproval?.()) button.textContent = 'Popup blocked — allow popups and retry';
        });
        box.append(title, copy, button);
        document.body.appendChild(box);
        approvalPrompt = box;
    }
    async function ensureRemote() {
        const R = remote();
        if (!R?.ready) return { ok: false, fallback: true, reason: 'Managed Spotify relay client is unavailable.' };
        let connection;
        try { connection = await R.connect(); }
        catch (error) {
            // Once the any-browser transport is loaded, a relay/network failure is ambiguous: a
            // managed engine may still be audible. Fail closed instead of creating a second player.
            return { ok: false, fallback: false, reason: String(error?.message || error) };
        }
        if (connection?.connected) { hideApprovalPrompt(); return { ok: true }; }
        if (!connection?.approvalRequired) {
            return { ok: false, fallback: false, reason: connection?.lastError || 'Managed Spotify relay is unavailable.' };
        }
        showApprovalPrompt(connection);
        try {
            await R.waitUntilReady(300000);
            hideApprovalPrompt();
            return { ok: true };
        } catch (error) {
            return { ok: false, fallback: false, reason: String(error?.message || error) };
        }
    }
    function applyEngineState(result) {
        if (!result?.ok || !active) return;
        const engine = result.engine || {};
        playback.currentTime = Math.max(0, Number(engine.currentTime || 0));
        playback.duration = Math.max(0, Number(engine.duration || playback.duration || item?.duration || 0));
        playback.paused = engine.paused !== false;
        const status = String(engine.status || '');
        if (!result.isOwner) {
            if (lastEngineStatus !== 'observer') {
                lastEngineStatus = 'observer';
                emitPlayback('Spotify controlled by another EveOS tab');
                refreshControls();
            }
            emitProgress();
            notify();
            return;
        }
        if (status === 'playing' && lastEngineStatus !== 'playing') {
            lastEngineStatus = 'playing';
            ended = false;
            emitPlayback(`Playing ${item?.title || 'Spotify track'} with Spotify`);
        } else if ((status === 'paused' || status === 'provider-paused') && lastEngineStatus !== status) {
            lastEngineStatus = status;
            emitPlayback('Paused');
        } else if (status === 'blocked' && lastEngineStatus !== 'blocked') {
            lastEngineStatus = 'blocked';
            emitPlayback(String(engine.error || 'Spotify playback needs attention in the managed engine.'), true);
        }
        const completionId = String(engine.completionId || '');
        if (status === 'ended' && completionId && completionId !== lastCompletionId) {
            lastCompletionId = completionId;
            lastEngineStatus = 'ended';
            ended = true;
            playback.paused = true;
            emitPlayback('Ended');
        }
        emitProgress();
        notify();
    }
    async function pollOnce() {
        if (!active || !remote()?.snapshot?.().connected) return;
        const result = await remote().status();
        applyEngineState(result);
    }
    function startPoll() {
        clearPoll();
        pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, 400);
        pollOnce().catch(() => {});
    }
    async function remotePlay(nextItem) {
        const id = spotifyId(nextItem);
        if (!id) throw new Error('This Spotify item has no valid track ID.');
        const connection = await ensureRemote();
        if (!connection.ok) {
            const error = new Error(connection.reason || 'Managed Spotify is unavailable.');
            error.eveSpotifyFallback = connection.fallback === true;
            throw error;
        }
        item = nextItem;
        playback = {
            item, currentTime: 0, duration: Number(item.duration || item.resolvedDuration || 0) || 0,
            paused: true, provider: 'spotify', browserOnly: true, remoteManaged: true
        };
        lastEngineStatus = '';
        lastCompletionId = '';
        ended = false;
        const result = await remote().send('play', {
            spotifyId: id,
            title: item.title || '',
            duration: playback.duration,
            effectiveVolume: effectiveGain(item.volume ?? 1),
            itemId: String(item.id || ''),
            type: String(item.type || 'music')
        }, { timeout: 20000 });
        if (!result?.ok) throw new Error(result?.reason || 'Managed Spotify playback failed.');
        active = true;
        applyEngineState(result);
        startPoll();
        refreshControls();
        return true;
    }
    async function stopRemote() {
        clearPoll();
        if (active && remote()?.snapshot?.().connected) {
            try { await remote().send('stop', {}, { timeout: 5000 }); } catch {}
        }
        const stopped = item;
        active = false;
        item = null;
        ended = false;
        playback = { item: stopped, currentTime: 0, duration: 0, paused: true, provider: 'spotify', browserOnly: true, remoteManaged: true };
        if (stopped) {
            emitPlayback('Stopped');
            emitProgress();
        }
        notify();
        refreshControls();
    }

    function install() {
        if (installed || !window.EveAudioflixAudio?.ready || !remote()?.ready) return false;
        installed = true;
        const audio = window.EveAudioflixAudio;
        const original = {
            playItem: audio.playItem.bind(audio),
            openInternalView: audio.openInternalView.bind(audio),
            pause: audio.pause.bind(audio),
            seek: audio.seek.bind(audio),
            stopAll: audio.stopAll.bind(audio),
            updateItemVolume: audio.updateItemVolume.bind(audio),
            getPlaybackState: audio.getPlaybackState.bind(audio),
            getStatus: audio.getStatus?.bind(audio)
        };

        audio.playItem = async function anyBrowserPlay(nextItem) {
            if (!isSpotify(nextItem)) {
                if (active) await stopRemote();
                return original.playItem(nextItem);
            }
            if (active && sameItem(item, nextItem) && !ended) {
                item = nextItem;
                playback.item = item;
                const ownsEngine = remote()?.snapshot?.().lastState?.isOwner === true;
                if (!ownsEngine) {
                    // Clicking Play is an explicit ownership transfer even when both clients point
                    // at the same library item. Re-issuing play creates a fresh track generation.
                    return remotePlay(nextItem);
                }
                if (playback.paused) {
                    const resumed = await remote().send('resume');
                    if (!resumed?.ok) throw new Error(resumed?.reason || 'Spotify could not resume.');
                    applyEngineState(resumed);
                }
                return true;
            }
            if (!active) await original.stopAll().catch(() => {});
            try { return await remotePlay(nextItem); }
            catch (error) {
                if (error?.eveSpotifyFallback) return original.playItem(nextItem);
                throw error;
            }
        };
        audio.openInternalView = async function anyBrowserInternal(nextItem) {
            if (!isSpotify(nextItem)) return original.openInternalView(nextItem);
            return audio.playItem(nextItem);
        };
        audio.pause = async function anyBrowserPause() {
            if (!active) return original.pause();
            const result = await remote().send('pause');
            if (!result?.ok) throw new Error(result?.reason || 'Spotify could not pause.');
            applyEngineState(result);
            return true;
        };
        audio.seek = async function anyBrowserSeek(seconds) {
            if (!active) return original.seek(seconds);
            const result = await remote().send('seek', { seconds: Math.max(0, Number(seconds || 0)) });
            if (!result?.ok) throw new Error(result?.reason || 'Spotify could not seek.');
            applyEngineState(result);
            return true;
        };
        audio.stopAll = async function anyBrowserStopAll() {
            if (!active) return original.stopAll();
            await stopRemote();
            return true;
        };
        audio.updateItemVolume = function anyBrowserVolume(itemId, rawVolume) {
            if (!active || String(item?.id || '') !== String(itemId || '')) {
                return original.updateItemVolume(itemId, rawVolume);
            }
            const safe = Math.max(0, Math.min(1, Number(rawVolume) || 0));
            item.volume = safe;
            playback.item = item;
            remote().send('volume', { effectiveVolume: effectiveGain(safe), spotifyId: spotifyId(item) }, { timeout: 5000 })
                .then((result) => { if (!result?.ok) console.warn('[Audioflix] Managed Spotify volume:', result?.reason || 'failed'); })
                .catch(() => {});
        };
        audio.getPlaybackState = function anyBrowserState() {
            return active ? { ...playback } : original.getPlaybackState();
        };
        if (original.getStatus) {
            audio.getStatus = function anyBrowserStatus() {
                const value = original.getStatus();
                return active ? { ...value, item, playback: { ...playback }, spotifyRemote: remote()?.snapshot?.() } : value;
            };
        }
        window.addEventListener('eve:audioflix-output-volume', () => {
            if (!active || !item) return;
            remote().send('volume', {
                effectiveVolume: effectiveGain(item.volume ?? 1), spotifyId: spotifyId(item)
            }, { timeout: 5000 }).catch?.(() => {});
        });
        notify();
        return true;
    }

    Object.assign(ns, {
        ready: true, install, snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    });
    if (!install()) window.addEventListener('load', install, { once: true });
})();