window.EveAudioflixSpotifyRemotePlayback = window.EveAudioflixSpotifyRemotePlayback || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyRemotePlayback;
    if (ns.ready) return;

    const remote = () => window.EveAudioflixSpotifyRemote;
    const effectiveGain = (raw) => {
        const safe = Math.max(0, Math.min(1, Number(raw ?? 1)));
        return Math.max(0, Math.min(1, Number(window.EveAudioflixOutputPort?.effective?.(safe) ?? safe)));
    };
    const spotifyId = (item) => String(item?.spotifyTrackId || item?.spotifyUrl || item?.url || item?.originalUrl || '')
        .match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)?([A-Za-z0-9]{22})(?:[?/#]|$)?/i)?.[1] || '';

    function create(ctx) {
        const { ensureStage, setStageStatus, emitPlayback, emitProgress } = ctx;
        const V = ctx.view;
        let pollTimer = 0;
        let selectedItem = null;
        let lastStatus = '';
        let lastCompletionId = '';
        let activePlayer = null;

        const clearPoll = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = 0; };
        function approvalUi(host, snapshot) {
            host.replaceChildren();
            const box = document.createElement('div');
            box.className = 'audioflix-provider-message';
            const text = document.createElement('p');
            text.textContent = `Approve this EveOS file tab to control Spotify. Pairing code: ${snapshot.code || '------'}`;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'audioflix-btn';
            button.textContent = 'Approve Spotify control';
            button.addEventListener('click', () => {
                if (!remote()?.openApproval?.()) {
                    setStageStatus('The approval popup was blocked. Allow popups for this local file and try again.', true);
                }
            });
            box.append(text, button);
            host.appendChild(box);
        }
        async function ensureConnected(item) {
            const R = remote();
            if (!R?.ready) return { ok: false, fallback: true, reason: 'Spotify relay client is unavailable.' };
            let connected;
            try { connected = await R.connect(); }
            catch (error) { return { ok: false, fallback: true, reason: error?.message || 'Spotify relay unavailable.' }; }
            if (connected?.connected) return { ok: true };
            if (!connected?.approvalRequired) {
                return { ok: false, fallback: true, reason: connected?.lastError || 'Spotify relay unavailable.' };
            }
            const host = ensureStage(item, 'Spotify', false);
            approvalUi(host, connected);
            setStageStatus(`Spotify control approval required. Confirm code ${connected.code || '------'} in the localhost approval window.`);
            try {
                await R.waitUntilReady(300000);
                host.replaceChildren();
                return { ok: true };
            } catch (error) {
                const message = error?.message || 'Spotify approval timed out.';
                setStageStatus(message, true);
                return { ok: false, fallback: false, reason: message };
            }
        }
        async function pollOnce() {
            const R = remote();
            if (!R?.snapshot?.().connected || !selectedItem) return;
            const result = await R.status();
            if (!result?.ok) return;
            const engine = result.engine || {};
            V.playback.currentTime = Math.max(0, Number(engine.currentTime || 0));
            V.playback.duration = Math.max(0, Number(engine.duration || V.playback.duration || 0));
            V.playback.paused = engine.paused !== false;
            const status = String(engine.status || '');
            if (!result.isOwner) {
                if (lastStatus !== 'observer') {
                    lastStatus = 'observer';
                    setStageStatus('Spotify is controlled by another EveOS tab. Play this track or Take control to move ownership here.');
                    emitPlayback('Spotify controlled by another EveOS tab');
                }
                emitProgress();
                return;
            }
            if (status === 'playing' && lastStatus !== 'playing') {
                lastStatus = 'playing';
                setStageStatus('Playing through the managed Spotify engine.');
                emitPlayback(`Playing ${selectedItem.title || 'Spotify track'} with Spotify`);
            } else if ((status === 'paused' || status === 'provider-paused') && lastStatus !== status) {
                lastStatus = status;
                setStageStatus(status === 'provider-paused'
                    ? 'Spotify paused outside Audioflix. Resume when you are ready.'
                    : 'Spotify paused.');
                emitPlayback('Paused');
            } else if (status === 'blocked' && lastStatus !== 'blocked') {
                lastStatus = 'blocked';
                const message = String(engine.error || 'Spotify needs a direct action in the managed engine window.');
                setStageStatus(message, true);
                emitPlayback(message, true);
            }
            const completionId = String(engine.completionId || '');
            if (status === 'ended' && completionId && completionId !== lastCompletionId) {
                lastCompletionId = completionId;
                lastStatus = 'ended';
                emitPlayback('Ended');
            }
            emitProgress();
        }
        function startPoll() {
            clearPoll();
            pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, 400);
            pollOnce().catch(() => {});
        }
        async function playItem(item) {
            const id = spotifyId(item);
            if (!id) throw new Error('This Spotify link does not contain a playable track ID.');
            selectedItem = item;
            lastStatus = '';
            lastCompletionId = '';
            ensureStage(item, 'Spotify', false).replaceChildren();
            setStageStatus('Connecting to the managed Spotify engine…');
            const result = await remote().send('play', {
                spotifyId: id,
                title: item.title || '',
                duration: Number(item.duration || item.resolvedDuration || 0),
                effectiveVolume: effectiveGain(item.volume ?? 1),
                itemId: String(item.id || ''),
                type: String(item.type || 'music')
            }, { timeout: 20000 });
            if (!result?.ok) throw new Error(result?.reason || 'Managed Spotify engine could not start playback.');
            startPoll();
            return result;
        }
        const player = {
            async play() {
                const result = await remote().send('resume');
                if (!result?.ok) throw new Error(result?.reason || 'Spotify could not resume.');
                startPoll();
                return result;
            },
            async pause() {
                const result = await remote().send('pause');
                if (!result?.ok) throw new Error(result?.reason || 'Spotify could not pause.');
                return result;
            },
            async setCurrentTime(seconds) {
                const result = await remote().send('seek', { seconds: Math.max(0, Number(seconds || 0)) });
                if (!result?.ok) throw new Error(result?.reason || 'Spotify could not seek.');
                return result;
            },
            async setVolume(volume) {
                const result = await remote().send('volume', {
                    effectiveVolume: Math.max(0, Math.min(1, Number(volume || 0))),
                    spotifyId: spotifyId(selectedItem)
                }, { timeout: 5000 });
                if (!result?.ok) throw new Error(result?.reason || 'Spotify volume control is unavailable.');
                return result;
            },
            async loadItem(item) {
                return playItem(item);
            },
            async destroy() {
                clearPoll();
                const result = await remote().send('stop', {}, { timeout: 5000 });
                selectedItem = null;
                return result;
            },
            async takeControl() {
                return remote().send('take-control');
            }
        };
        activePlayer = player;

        async function tryPlaySpotify(item) {
            const connection = await ensureConnected(item);
            if (!connection.ok) return { used: !connection.fallback, error: connection.reason };
            V.active = { kind: 'spotify', player: activePlayer, remote: true };
            try {
                await playItem(item);
                return { used: true, ok: true };
            } catch (error) {
                clearPoll();
                V.active = null;
                return { used: true, error: error?.message || 'Managed Spotify playback failed.' };
            }
        }
        return { tryPlaySpotify, player };
    }

    function install() {
        const target = window.EveAudioflixSpotifyPlayback;
        if (!target?.create || target.__remoteWrapped) return false;
        const originalCreate = target.create.bind(target);
        target.create = function wrappedCreate(ctx) {
            const local = originalCreate(ctx);
            const managed = create(ctx);
            return {
                ...local,
                async playSpotify(item) {
                    const result = await managed.tryPlaySpotify(item);
                    if (result.used) {
                        if (result.ok) return;
                        const error = new Error(result.error || 'Managed Spotify playback failed.');
                        error.eveReported = false;
                        throw error;
                    }
                    return local.playSpotify(item);
                }
            };
        };
        target.__remoteWrapped = true;
        return true;
    }

    Object.assign(ns, { ready: true, create, install });
    install();
})();
