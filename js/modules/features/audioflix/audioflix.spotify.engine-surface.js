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

    function show(item) {
        const controller = ensureView();
        if (!controller || !managedActive()) return false;
        currentItem = item || managed()?.snapshot?.().item || currentItem;
        const host = controller.open(currentItem || {}, 'Spotify Engine', { expanded: true, visible: true });
        controller.setStatus('Managed Spotify engine is running in the background. This view mirrors it inside EveOS.');
        controller.setVisualVisible(true);
        host.replaceChildren();

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
            return { open: Boolean(frame && view?.isOpen?.()), managedActive: managedActive(), item: currentItem };
        }
    });
    if (!install()) window.addEventListener('load', install, { once: true });
})();
