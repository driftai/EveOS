/* Audioflix: official Spotify embed volume on the localhost EveOS surface.
 *
 * Spotify's cross-origin iframe exposes no documented volume method. On a secure localhost page
 * Chrome/Edge can let EveOS capture its own tab audio, suppress the original local playback, and
 * replay that same Spotify audio through a Web Audio GainNode. This stays Spotify-sourced and does
 * not use YouTube, yt-dlp, or the EveOS extension.
 */
(function () {
    'use strict';

    const OUTPUT_WINDOW = 'eveos_audioflix_sound_output';
    const VOLUME_SELECTOR = [
        '[data-af-spv="slider"]',
        '.audioflix-volume-slider',
        '.audioflix-provider-volume',
        '.audioflix-output-port-volume'
    ].join(', ');
    const state = {
        stream: null,
        output: null,
        context: null,
        gain: null,
        spotifyActive: false,
        directControl: false,
        spotifyVolume: 1,
        status: 'off',
        message: '',
        tabLabel: ''
    };
    const listeners = new Set();

    const clamp = (value) => Math.max(0, Math.min(1,
        Number.isFinite(Number(value)) ? Number(value) : 1));
    const isLocalhost = () => /^(?:localhost|127\.0\.0\.1)$/i.test(location.hostname || '');
    const supported = () => isLocalhost()
        && window.isSecureContext === true
        && !!navigator.mediaDevices
        && typeof navigator.mediaDevices.getDisplayMedia === 'function';
    const targetGain = () => state.spotifyActive && !state.directControl ? state.spotifyVolume : 1;
    const spotifyTrack = (item) => String(item?.sourceProvider || '').toLowerCase() === 'spotify'
        || !!item?.spotifyUrl
        || /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)/i.test(String(item?.url || item?.originalUrl || ''));

    function activeSpotifyPlayback() {
        const playback = window.EveAudioflixAudio?.getPlaybackState?.() || {};
        return playback.provider === 'spotify' || spotifyTrack(playback.item) ? playback : null;
    }

    function effectiveTrackGain(playback = activeSpotifyPlayback()) {
        const itemVolume = clamp(playback?.item?.volume ?? 1);
        return window.EveAudioflixOutputPort?.effective?.(itemVolume) ?? itemVolume;
    }

    function snapshot() {
        return {
            supported: supported(),
            status: state.status,
            message: state.message,
            active: state.status === 'on' || state.status === 'needs-click',
            spotifyActive: state.spotifyActive,
            directControl: state.directControl,
            volume: state.spotifyVolume,
            gain: targetGain(),
            tabLabel: state.tabLabel
        };
    }

    function notify() {
        const value = snapshot();
        listeners.forEach((listener) => {
            try { listener(value); } catch { /* A view subscriber must not break audio. */ }
        });
        renderAll();
    }

    function applyGain() {
        if (!state.gain || !state.context) return;
        try {
            state.gain.gain.setTargetAtTime(targetGain(), state.context.currentTime, 0.015);
        } catch {
            state.gain.gain.value = targetGain();
        }
    }

    function writeOutputWindow(win) {
        const doc = win.document;
        doc.open();
        doc.write('<!doctype html><title>AudioFlix sound output</title>'
            + '<body style="margin:0;font:13px system-ui;background:#111;color:#ddd;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;height:100vh;text-align:center">'
            + '<div>AudioFlix is playing Spotify sound through EveOS.</div>'
            + '<div style="opacity:.7">Keep this window open. Closing it turns volume control off.</div>'
            + '<button id="afStart" hidden style="padding:6px 14px">Click to start sound</button></body>');
        doc.close();
    }

    function connectInOutput(win, stream) {
        const Context = win.AudioContext || win.webkitAudioContext;
        if (!Context) throw new Error('This browser cannot play captured audio.');
        const context = new Context({ latencyHint: 'playback' });
        let source;
        try {
            source = context.createMediaStreamSource(stream);
        } catch {
            source = context.createMediaStreamSource(new win.MediaStream(stream.getAudioTracks()));
        }
        const gain = context.createGain();
        gain.gain.value = targetGain();
        source.connect(gain).connect(context.destination);
        return { context, gain };
    }

    // Capture-only constraints such as suppressLocalAudioPlayback belong on getDisplayMedia().
    // Re-applying them afterward with MediaStreamTrack.applyConstraints() is unreliable in Chromium
    // and can tear down an otherwise valid capture. This helper deliberately INSPECTS only.
    async function applyCapturePolicy(stream, audioTrack) {
        const audioSettings = audioTrack.getSettings?.() || {};
        const videoSettings = stream.getVideoTracks()[0]?.getSettings?.() || {};
        return {
            surface: videoSettings.displaySurface || '',
            suppression: audioSettings.suppressLocalAudioPlayback
                ?? videoSettings.suppressLocalAudioPlayback,
            restrictOwnAudio: audioSettings.restrictOwnAudio
        };
    }

    function captureAudioConstraints() {
        const supportedConstraints = navigator.mediaDevices.getSupportedConstraints?.() || {};
        const audio = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        };
        if (supportedConstraints.suppressLocalAudioPlayback) {
            audio.suppressLocalAudioPlayback = true;
        }
        // EveOS is capturing the SAME tab that contains the Spotify iframe. If Chromium's own-audio
        // filter is supported, explicitly disable it so Spotify remains present in the captured track.
        if (supportedConstraints.restrictOwnAudio) {
            audio.restrictOwnAudio = false;
        }
        return audio;
    }

    function teardown() {
        const { stream, context, output } = state;
        Object.assign(state, {
            stream: null,
            context: null,
            gain: null,
            output: null,
            tabLabel: ''
        });
        try { stream?.getTracks().forEach((track) => track.stop()); } catch { /* best effort */ }
        try { context?.close(); } catch { /* best effort */ }
        try { if (output && !output.closed) output.close(); } catch { /* best effort */ }
    }

    function disable(message = '') {
        if (state.status === 'off' && !state.stream) return snapshot();
        teardown();
        state.status = 'off';
        state.message = message;
        notify();
        return snapshot();
    }

    async function enable() {
        if (state.status === 'on' || state.status === 'starting') return snapshot();
        if (!supported()) {
            state.status = 'error';
            state.message = isLocalhost()
                ? 'This browser cannot share the EveOS tab audio.'
                : 'Open EveOS through localhost to enable Spotify volume control.';
            notify();
            return snapshot();
        }

        state.status = 'starting';
        state.message = 'Choose “This tab” and keep “Also share tab audio” enabled.';
        notify();

        // This must execute directly inside the trusted pointer/key gesture. Both window.open() and
        // getDisplayMedia() are user-activation gated in Chromium.
        const win = window.open('', OUTPUT_WINDOW, 'width=360,height=150');
        if (!win) {
            state.status = 'error';
            state.message = 'Allow the AudioFlix sound-output window and move the volume slider again.';
            notify();
            return snapshot();
        }

        try {
            writeOutputWindow(win);
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { max: 1 } },
                audio: captureAudioConstraints(),
                preferCurrentTab: true,
                selfBrowserSurface: 'include',
                surfaceSwitching: 'exclude',
                systemAudio: 'exclude',
                monitorTypeSurfaces: 'exclude'
            });
            const audioTrack = stream.getAudioTracks()[0];
            if (!audioTrack) {
                stream.getTracks().forEach((track) => track.stop());
                throw new Error('No tab audio was shared. Enable “Also share tab audio” and try again.');
            }

            const capturePolicy = await applyCapturePolicy(stream, audioTrack);
            if (capturePolicy.surface && capturePolicy.surface !== 'browser') {
                stream.getTracks().forEach((track) => track.stop());
                throw new Error('Choose the EveOS tab—not a window or screen—for Spotify volume control.');
            }
            if (capturePolicy.restrictOwnAudio === true) {
                stream.getTracks().forEach((track) => track.stop());
                throw new Error('Chrome filtered EveOS tab audio from the capture. Re-select This Tab with tab audio enabled.');
            }
            if (capturePolicy.suppression === false) {
                stream.getTracks().forEach((track) => track.stop());
                throw new Error('Chrome did not suppress the original Spotify output, so EveOS cannot own its volume. Re-select This Tab with tab audio enabled.');
            }

            stream.getVideoTracks().forEach((track) => { track.enabled = false; });
            const { context, gain } = connectInOutput(win, stream);
            Object.assign(state, {
                stream,
                output: win,
                context,
                gain,
                tabLabel: document.title || 'EveOS'
            });
            stream.getTracks().forEach((track) => {
                track.addEventListener('ended', () => disable('Tab sharing stopped.'), { once: true });
            });
            win.addEventListener('pagehide', () => disable('Sound window closed.'), { once: true });

            await context.resume().catch(() => {});
            if (context.state !== 'running') {
                state.status = 'needs-click';
                state.message = 'Click “Click to start sound” in the AudioFlix sound window.';
                const button = win.document.getElementById('afStart');
                if (button) {
                    button.hidden = false;
                    button.addEventListener('click', async () => {
                        await context.resume().catch(() => {});
                        if (context.state !== 'running') return;
                        button.hidden = true;
                        state.status = 'on';
                        state.message = '';
                        applyGain();
                        notify();
                    });
                }
            } else {
                state.status = 'on';
                state.message = '';
            }
            applyGain();
        } catch (error) {
            try { win.close(); } catch { /* best effort */ }
            teardown();
            state.status = error?.name === 'NotAllowedError' ? 'off' : 'error';
            state.message = error?.name === 'NotAllowedError'
                ? ''
                : (error?.message || 'Spotify volume control could not start.');
        }
        notify();
        return snapshot();
    }

    function setSpotifyVolume(volume, options = {}) {
        state.spotifyActive = true;
        state.directControl = options.direct === true;
        state.spotifyVolume = clamp(volume);
        applyGain();
        notify();
    }

    function clearSpotify() {
        if (!state.spotifyActive) return;
        state.spotifyActive = false;
        state.directControl = false;
        applyGain();
        notify();
    }

    function syncSpotifyFromPlayback(explicitItemVolume) {
        const playback = activeSpotifyPlayback();
        if (!playback) return null;
        const itemVolume = explicitItemVolume == null
            ? clamp(playback.item?.volume ?? 1)
            : clamp(explicitItemVolume);
        const effective = window.EveAudioflixOutputPort?.effective?.(itemVolume) ?? itemVolume;
        setSpotifyVolume(effective, { direct: false });
        return playback;
    }

    function armFromTrustedGesture(target) {
        if (!target?.closest?.(VOLUME_SELECTOR) && !target?.matches?.(VOLUME_SELECTOR)) return false;
        const playback = syncSpotifyFromPlayback();
        if (!playback) return false;
        const value = snapshot();
        if (!value.active && value.status !== 'starting') void enable();
        return true;
    }

    const escapeHtml = (value) => String(value).replace(/[&<>"]/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

    function barHtml() {
        const value = snapshot();
        if (!value.supported) {
            return '<div class="af-spv-row"><span class="af-spv-note">Open EveOS through localhost in Chrome or Edge for Spotify volume control.</span></div>';
        }
        const on = value.active;
        const percent = Math.round(value.volume * 100);
        return `<div class="af-spv-row">`
            + `<button type="button" class="af-spv-toggle" data-af-spv="toggle" ${value.status === 'starting' ? 'disabled' : ''}>${on ? 'Stop volume control' : 'Enable volume control'}</button>`
            + `<input type="range" class="af-spv-slider" data-af-spv="slider" min="0" max="1" step="0.01" value="${value.volume}" ${on ? '' : 'disabled'} aria-label="Spotify volume">`
            + `<span class="af-spv-pct">${percent}%</span></div>`
            + `<div class="af-spv-meta">${on ? `Controlling: ${escapeHtml(value.tabLabel)} (this tab)` : 'EveOS can control the official Spotify audio on localhost.'}</div>`
            + (value.message ? `<div class="af-spv-note">${escapeHtml(value.message)}</div>` : '');
    }

    function renderAll() {
        document.querySelectorAll('.af-spotify-volume').forEach((element) => {
            const slider = element.querySelector('[data-af-spv="slider"]');
            if (slider && document.activeElement === slider) {
                const percent = element.querySelector('.af-spv-pct');
                if (percent) percent.textContent = `${Math.round(state.spotifyVolume * 100)}%`;
                return;
            }
            element.innerHTML = barHtml();
        });
    }

    function mount(host) {
        if (!host) return null;
        let element = host.querySelector(':scope > .af-spotify-volume');
        if (!element) {
            element = document.createElement('div');
            element.className = 'af-spotify-volume';
            element.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:6px 2px;font-size:12px';
            host.appendChild(element);
        }
        element.innerHTML = barHtml();
        return element;
    }

    document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-af-spv="toggle"]');
        if (!button) return;
        if (snapshot().active) disable();
        else {
            syncSpotifyFromPlayback();
            void enable();
        }
    });

    // Capture permission requires transient activation. Arm at the actual pointer/key gesture rather
    // than waiting for the range input event, which can occur after Chromium considers activation spent.
    document.addEventListener('pointerdown', (event) => {
        armFromTrustedGesture(event.target);
    }, true);
    document.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
        armFromTrustedGesture(event.target);
    }, true);

    document.addEventListener('input', (event) => {
        const slider = event.target?.closest?.(VOLUME_SELECTOR);
        if (!slider) return;
        const level = clamp(slider.value);
        const audio = window.EveAudioflixAudio;
        const playback = activeSpotifyPlayback();
        const activeId = audio?.getPlaybackState?.()?.item?.id;
        const isMaster = slider.matches('.audioflix-output-port-volume');

        if (!isMaster) {
            if (activeId != null && typeof audio?.updateItemVolume === 'function') {
                audio.updateItemVolume(activeId, level);
            }
            document.querySelectorAll('.audioflix-volume-slider').forEach((card) => {
                if (String(card.dataset.afId) !== String(activeId)) return;
                card.value = String(level);
                card.style.setProperty('--vol', `${level * 100}%`);
                const label = card.parentElement?.querySelector('.audioflix-volume-label');
                if (label) label.textContent = `${Math.round(level * 100)}%`;
            });
        }

        // Do not depend on URL-player identity matching. If Spotify is the active provider, update
        // the authoritative localhost gain directly from the visible slider state.
        if (playback) {
            const itemVolume = isMaster ? clamp(playback.item?.volume ?? 1) : level;
            const effective = window.EveAudioflixOutputPort?.effective?.(itemVolume) ?? itemVolume;
            setSpotifyVolume(effective, { direct: false });
            if (!snapshot().active && state.status !== 'starting') void enable();
        }
    });

    window.EveAudioflixSpotifyVolume = {
        enable,
        disable,
        setSpotifyVolume,
        clearSpotify,
        applyCapturePolicy,
        captureAudioConstraints,
        activeSpotifyPlayback,
        syncSpotifyFromPlayback,
        armFromTrustedGesture,
        mount,
        snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
})();