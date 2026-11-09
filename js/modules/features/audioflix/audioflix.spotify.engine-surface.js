window.EveAudioflixSpotifyEngineSurface = window.EveAudioflixSpotifyEngineSurface || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyEngineSurface;
    if (ns.ready) return;

    const isSpotify = (item) => !!window.EveAudioflixSpotifyMedia?.fromItem(item);
    const remote = () => window.EveAudioflixSpotifyRemote;
    const managed = () => window.EveAudioflixSpotifyAnyBrowser;
    const queueConnection = () => window.EveAudioflix?.queueConnection || null;

    let installed = false;
    let view = null;
    let frame = null;
    let frameOrigin = '';
    let currentItem = null;
    let originalOpenInternalView = null;
    let presentationBusy = false;

    function managedActive() {
        const snapshot = managed()?.snapshot?.() || {};
        return snapshot.active === true && remote()?.snapshot?.().connected === true;
    }

    // The mirror is a view of live playback, not a controller locked to its opening item.
    // Resolve again on input: a queue advance may precede its next progress/render event.
    function playbackItem() {
        const snapshot = managed()?.snapshot?.() || {};
        return snapshot.active === true ? snapshot.playback?.item || snapshot.item || null : null;
    }

    function mirrorBase() {
        const value = String(remote()?.snapshot?.().base || '').trim();
        try {
            const url = new URL(value || 'http://127.0.0.1:8765');
            if (/^https?:$/.test(url.protocol) && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return url.origin;
        } catch {}
        return 'http://127.0.0.1:8765';
    }

    function managedPresentation() {
        return String(remote()?.snapshot?.().lastState?.managed?.presentation || 'hidden');
    }

    function syncQueue() {
        const snapshot = queueConnection()?.snapshot?.() || {};
        const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
        const index = Number.isInteger(Number(snapshot.currentIndex)) ? Number(snapshot.currentIndex) : -1;
        view?.setQueue?.(entries, index);
    }

    function postMirrorState() {
        const snapshot = managed()?.snapshot?.() || {};
        const playback = snapshot.playback || {};
        const engine = remote()?.snapshot?.().lastState?.engine || {};
        if (frame && playbackItem()) currentItem = playbackItem();
        syncQueue();
        view?.sync?.(playback);
        if (currentItem) view?.setVolume?.(currentItem.volume ?? 1);
        if (!frame?.contentWindow || !frameOrigin) return;
        frame.contentWindow.postMessage({
            type: 'eveos:spotify-engine-mirror-state',
            version: 1,
            state: {
                title: String(snapshot.item?.title || currentItem?.title || 'Spotify'),
                status: String(engine.status || (playback.paused === false ? 'Playing' : 'Paused')),
                currentTime: Number(playback.currentTime || engine.currentTime || 0),
                duration: Number(playback.duration || engine.duration || 0),
                paused: playback.paused !== false
            }
        }, frameOrigin);
    }

    function ensureView() {
        if (view) return view;
        const factory = window.EveAudioflixInternalPlayer?.createController;
        if (typeof factory !== 'function') return null;
        view = factory({
            onClose: () => hide(),
            onToggle: async () => {
                const playback = managed()?.snapshot?.().playback || {};
                if (playback.paused === false) return window.EveAudioflixAudio?.pause?.();
                // An Engine restart retires the transport but must not lose the selected song.
                const item = playbackItem() || currentItem;
                if (item) return window.EveAudioflixAudio?.playItem?.(item);
            },
            onSeek: (value) => window.EveAudioflixAudio?.seek?.(value),
            onStep: (delta) => queueConnection()?.step?.(Number(delta) || 0),
            onJump: (index) => queueConnection()?.jump?.(Number(index) || 0),
            getVolumeItem: playbackItem,
            onVolume: (value, options = {}) => {
                const item = playbackItem();
                const id = options.itemId ?? item?.id;
                if (id === null || id === undefined || !(window.EveAudioflixVolumeTarget?.allows?.(item, options) ?? options.type === undefined)) return;
                if (options.persist !== false) window.EveAudioflixState?.setItemVolume?.(item?.type || 'music', id, value);
                window.EveAudioflixAudio?.updateItemVolume?.(id, value, { ...options, persist: false });
            }
        });
        return view;
    }

    async function setPresentation(mode, button) {
        if (presentationBusy || !remote()?.snapshot?.().connected) return;
        presentationBusy = true;
        const originalText = button?.textContent || '';
        if (button) button.textContent = 'Working…';
        try {
            const result = await window.EveAudioflixSpotifyManagement?.setPresentation?.(mode);
            if (!result?.ok) throw new Error(result?.reason || `Could not switch Spotify engine to ${mode}.`);
            view?.setStatus?.(mode === 'headless'
                ? 'Spotify engine is true headless. Control/state remain available; Windows audio may be silent.'
                : `Spotify engine presentation: ${mode}. Audio remains on the single managed engine.`);
            postMirrorState();
        } catch (error) {
            view?.setStatus?.(String(error?.message || error));
        } finally {
            presentationBusy = false;
            if (button) button.textContent = originalText;
        }
    }

    async function restartEngine(button) {
        if (presentationBusy || !button) return;
        const defaultLabel = 'Restart engine';
        if (button.dataset.confirmSpotifyRestart !== 'true') {
            button.dataset.confirmSpotifyRestart = 'true';
            button.textContent = 'Confirm restart';
            view?.setStatus?.('Restart managed Spotify engine? Current playback will stop and will not auto-resume. AudioFlix keeps queue authority.');
            setTimeout(() => {
                if (presentationBusy || !button.isConnected || button.dataset.confirmSpotifyRestart !== 'true') return;
                delete button.dataset.confirmSpotifyRestart;
                button.textContent = defaultLabel;
            }, 8000);
            return;
        }
        delete button.dataset.confirmSpotifyRestart;
        presentationBusy = true;
        button.textContent = 'Restarting…';
        try {
            // The shared facade retires playback before replacing the helper and invalidates the
            // old relay identity, so Nexus and Internal Player cannot diverge on restart.
            const result = await window.EveAudioflixSpotifyManagement?.restart?.();
            if (result?.serviceRestarted !== true) throw new Error(result?.message || 'Managed Spotify engine did not verify a fresh idle helper.');
            view?.setStatus?.('Managed Spotify engine restarted and is idle. Playback was not auto-resumed; use Play when you are ready.');
            postMirrorState();
        } catch (error) {
            view?.setStatus?.(String(error?.message || error));
        } finally {
            presentationBusy = false;
            if (button.isConnected) button.textContent = defaultLabel;
        }
    }

    async function stopEngine(button) {
        if (presentationBusy || !remote()?.snapshot?.().connected) return;
        presentationBusy = true;
        const originalText = button?.textContent || '';
        if (button) button.textContent = 'Stopping…';
        try {
            const result = await window.EveAudioflixSpotifyManagement?.stopEngine?.();
            if (!result?.ok) throw new Error(result?.reason || 'Could not stop the Spotify engine.');
            view?.setStatus?.('Managed Spotify engine stopped. Internal controls remain available; press Play to launch it again.');
            postMirrorState();
        } catch (error) {
            view?.setStatus?.(String(error?.message || error));
            if (button) button.textContent = originalText;
        } finally {
            presentationBusy = false;
        }
    }

    async function captureManagedEngine(button) {
        if (presentationBusy) return;
        const originalText = button?.textContent || '';
        if (button) button.textContent = 'Choose engine tab…';
        try {
            const status = await window.EveAudioflixProviderCaptureUi?.armManagedSpotify?.();
            view?.setStatus?.(status?.message || 'Managed Spotify capture armed.');
        } catch (error) {
            view?.setStatus?.(String(error?.message || error));
        } finally {
            if (button) button.textContent = originalText;
        }
    }

    function makeButton(label, action, title = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (title) button.title = title;
        Object.assign(button.style, {
            border: '1px solid rgba(208,174,73,.5)', borderRadius: '999px', padding: '6px 10px',
            background: 'rgba(26,30,28,.92)', color: '#e8d893', cursor: 'pointer', font: '12px system-ui,sans-serif'
        });
        button.addEventListener('click', () => action(button));
        return button;
    }

    function createPresentationControls() {
        const wrap = document.createElement('div');
        wrap.dataset.spotifyEngineControls = 'true';
        Object.assign(wrap.style, {
            display: 'flex', gap: '7px', flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px',
            borderBottom: '1px solid rgba(208,174,73,.18)', background: 'rgba(8,14,13,.78)'
        });
        const label = document.createElement('span');
        label.textContent = `Engine · ${managedPresentation()}`;
        Object.assign(label.style, { color: '#80e7ff', font: '700 11px system-ui,sans-serif', marginRight: '4px' });
        wrap.append(
            label,
            makeButton('Hidden (default)', (button) => setPresentation('hidden', button), 'Headed Edge hidden from desktop; normal Windows audio.'),
            makeButton('Window', (button) => setPresentation('window', button), 'Show the managed Edge engine for debugging or sign-in.'),
            makeButton('Minimized', (button) => setPresentation('background', button), 'Keep the headed engine minimized.'),
            makeButton('True headless (silent)', (button) => setPresentation('headless', button), 'No browser window. Control/state work, but Windows audio may be silent.'),
            makeButton('Capture to native output', (button) => captureManagedEngine(button), 'After showing the engine, choose its browser tab and enable Share tab audio.'),
            makeButton('Restart engine', (button) => restartEngine(button), 'Restart only the managed Spotify helper. Playback stops and does not auto-resume.'),
            makeButton('Stop engine', (button) => stopEngine(button), 'Close the managed Spotify subsystem until the next Spotify Play.')
        );
        return wrap;
    }

    function show(item, options = {}) {
        const controller = ensureView();
        if (!controller || (!managedActive() && options.allowIdle !== true)) return false;
        currentItem = playbackItem() || item || currentItem;
        const host = controller.open(currentItem || {}, 'Spotify Engine', { expanded: true, visible: true });
        controller.setStatus(managedActive()
            ? 'Managed Spotify engine is running in the background. This view mirrors it inside EveOS.'
            : 'Opening managed Spotify engine… Controls will remain available even if launch fails.');
        controller.setVisualVisible(true);
        syncQueue();
        host.replaceChildren();
        host.classList?.add?.('is-spotify-engine-mirror');
        host.appendChild(createPresentationControls());

        const iframe = document.createElement('iframe');
        const base = mirrorBase();
        frameOrigin = new URL(base).origin;
        iframe.src = `${base}/tools/audioflix/spotify-engine.html?surface=mirror`;
        iframe.title = 'EveOS Spotify Engine';
        iframe.referrerPolicy = 'no-referrer';
        iframe.setAttribute('aria-label', 'Managed Spotify engine view');
        iframe.addEventListener('load', postMirrorState);
        host.appendChild(iframe);
        frame = iframe;
        postMirrorState();
        return true;
    }

    function hide() {
        try { frame?.parentElement?.classList?.remove?.('is-spotify-engine-mirror'); } catch {}
        try { frame?.remove?.(); } catch {}
        frame = null;
        frameOrigin = '';
        currentItem = null;
        view?.hide?.();
    }

    function install() {
        if (installed || !window.EveAudioflixAudio?.ready || !managed()?.ready) return false;
        installed = true;
        const audio = window.EveAudioflixAudio;
        originalOpenInternalView = audio.openInternalView.bind(audio);
        audio.openInternalView = async function managedEngineInternalView(item) {
            const policy = window.EveAudioflixPlaybackPolicy?.resolve?.(item) || {};
            if (!isSpotify(item) || policy.spotifyMethod === 'embed') {
                hide();
                return originalOpenInternalView(item);
            }
            // This view is the sole managed Engine panel. Calling the previous
            // Internal View handler here opens an independent legacy player panel.
            const opened = show(item, { allowIdle: true });
            if (!opened) return originalOpenInternalView(item);
            // Retire any legacy Internal View left visible by earlier playback.
            audio.hideInternalView?.();
            try {
                const identity = window.EveAudioflixSpotifyMedia?.fromItem?.(item);
                const snapshot = managed()?.snapshot?.() || {};
                const activeItem = snapshot.playback?.item || snapshot.item;
                const activeIdentity = window.EveAudioflixSpotifyMedia?.fromItem?.(activeItem);
                // An eye click only reveals the panel; do not restart or resume
                // an already-selected Engine track (including a paused track).
                if (snapshot.active === true && identity && activeIdentity &&
                    identity.spotifyUri === activeIdentity.spotifyUri) {
                    postMirrorState();
                    return true;
                }
                // Start a different/idle Engine track through the one Audioflix
                // playback owner, never through the legacy Internal View owner.
                const started = await audio.playItem(item);
                if (managedActive()) {
                    postMirrorState();
                    return started;
                }
                const playback = audio.getPlaybackState?.() || {};
                // A localized-policy fallback really can choose a local file.
                // Present its existing transport once; never start it a second time.
                if (started && playback.item && playback.remoteManaged !== true) {
                    hide();
                    audio.presentExternalTransport?.(playback.item, playback);
                    return started;
                }
                view?.setStatus?.('Spotify engine is idle; press Play or use the controls above.');
                return started;
            } catch (error) {
                view?.setStatus?.(String(error?.message || error));
                throw error;
            }
        };
        window.addEventListener('eve:audioflix-playback', (event) => {
            if (event?.detail?.item && !isSpotify(event.detail.item) && !managedActive()) hide();
            else postMirrorState();
        });
        window.addEventListener('eve:audioflix-progress', () => {
            if (managedActive()) postMirrorState();
        });
        window.addEventListener('eve:audioflix-queue-changed', () => {
            if (managedActive()) syncQueue();
        });
        return true;
    }

    Object.assign(ns, {
        ready: true,
        install,
        show,
        hide,
        snapshot() {
            return {
                open: Boolean(frame && view?.isOpen?.()), managedActive: managedActive(),
                presentation: managedPresentation(), item: currentItem
            };
        }
    });
    if (!install()) window.addEventListener('load', install, { once: true });
})();
