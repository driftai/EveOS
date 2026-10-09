window.EveAudioflixSpotifyEngineSurface = window.EveAudioflixSpotifyEngineSurface || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyEngineSurface;
    if (ns.ready) return;

    const isSpotify = (item) => String(item?.sourceProvider || '').toLowerCase() === 'spotify'
        || !!item?.spotifyUrl
        || /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)/i.test(String(item?.url || item?.originalUrl || ''));
    const remote = () => window.EveAudioflixSpotifyRemote;
    const managed = () => window.EveAudioflixSpotifyAnyBrowser;

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

    function postMirrorState() {
        if (!frame?.contentWindow || !frameOrigin) return;
        const snapshot = managed()?.snapshot?.() || {};
        const playback = snapshot.playback || {};
        const engine = remote()?.snapshot?.().lastState?.engine || {};
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
        view?.sync?.(playback);
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
                if (currentItem) return window.EveAudioflixAudio?.playItem?.(currentItem);
            },
            onSeek: (value) => window.EveAudioflixAudio?.seek?.(value),
            onVolume: (value) => {
                if (!currentItem?.id) return;
                window.EveAudioflixAudio?.updateItemVolume?.(currentItem.id, value);
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
            const result = await remote().send('engine-presentation', { mode }, { timeout: 25000 });
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

    async function stopEngine(button) {
        if (presentationBusy || !remote()?.snapshot?.().connected) return;
        presentationBusy = true;
        const originalText = button?.textContent || '';
        if (button) button.textContent = 'Stopping…';
        try {
            const result = await remote().send('engine-stop', {}, { timeout: 12000 });
            if (!result?.ok) throw new Error(result?.reason || 'Could not stop the Spotify engine.');
            try { await window.EveAudioflixAudio?.stopAll?.(); } catch {}
            hide();
        } catch (error) {
            view?.setStatus?.(String(error?.message || error));
            if (button) button.textContent = originalText;
        } finally {
            presentationBusy = false;
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
            makeButton('Stop engine', (button) => stopEngine(button), 'Close the managed Spotify subsystem until the next Spotify Play.')
        );
        return wrap;
    }

    function show(item) {
        const controller = ensureView();
        if (!controller || !managedActive()) return false;
        currentItem = item || managed()?.snapshot?.().item || currentItem;
        const host = controller.open(currentItem || {}, 'Spotify Engine', { expanded: true, visible: true });
        controller.setStatus('Managed Spotify engine is running in the background. This view mirrors it inside EveOS.');
        controller.setVisualVisible(true);
        host.replaceChildren();
        host.appendChild(createPresentationControls());

        const iframe = document.createElement('iframe');
        const base = mirrorBase();
        frameOrigin = new URL(base).origin;
        iframe.src = `${base}/audioflix-spotify-engine.html?surface=mirror`;
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
            const result = await originalOpenInternalView(item);
            if (isSpotify(item) && managedActive()) show(item);
            return result;
        };
        window.addEventListener('eve:audioflix-playback', () => {
            if (!managedActive()) hide();
            else postMirrorState();
        });
        window.addEventListener('eve:audioflix-progress', () => {
            if (managedActive()) postMirrorState();
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
