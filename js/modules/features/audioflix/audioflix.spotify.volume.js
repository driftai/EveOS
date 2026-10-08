/* Audioflix: official Spotify embed volume on the localhost EveOS surface.
 *
 * Spotify's cross-origin iframe exposes no volume method. On a secure localhost page Chrome can
 * let EveOS capture its own tab audio, suppress the original output, and replay that same Spotify
 * audio through a Web Audio GainNode. This remains page-owned and does not use the EveOS extension
 * or replace Spotify with another provider.
 */
(function () {
    'use strict';

    const OUTPUT_WINDOW = 'eveos_audioflix_sound_output';
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

    async function applyCapturePolicy(stream, audioTrack) {
        const supportedConstraints = navigator.mediaDevices.getSupportedConstraints?.() || {};
        const constraints = {};
        if (supportedConstraints.suppressLocalAudioPlayback) {
            constraints.suppressLocalAudioPlayback = { exact: true };
        }
        // Chromium may otherwise filter sound produced by the capturing tab out of its own
        // captured stream. Spotify is inside that tab, so the gain path needs this explicitly off.
        if (supportedConstraints.restrictOwnAudio) constraints.restrictOwnAudio = { exact: false };
        if (Object.keys(constraints).length && typeof audioTrack.applyConstraints === 'function') {
            await audioTrack.applyConstraints(constraints);
        }
        const audioSettings = audioTrack.getSettings?.() || {};
        const videoSettings = stream.getVideoTracks()[0]?.getSettings?.() || {};
        return {
            surface: videoSettings.displaySurface || '',
            suppression: audioSettings.suppressLocalAudioPlayback
                ?? videoSettings.suppressLocalAudioPlayback
        };
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

        // Open synchronously inside the click before awaiting the browser picker.
        const win = window.open('', OUTPUT_WINDOW, 'width=360,height=150');
        if (!win) {
            state.status = 'error';
            state.message = 'Allow the AudioFlix sound-output window and try again.';
            notify();
            return snapshot();
        }

        try {
            writeOutputWindow(win);
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { max: 1 } },
                audio: {
                    suppressLocalAudioPlayback: true,
                    restrictOwnAudio: false,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                },
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
                        notify();
                    });
                }
            } else {
                state.status = 'on';
                state.message = '';
            }
            if (capturePolicy.suppression === false) {
                state.message = 'Chrome did not suppress the original tab audio; stop control and select the EveOS tab again.';
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
        else enable();
    });

    document.addEventListener('input', (event) => {
        const slider = event.target?.closest?.(
            '[data-af-spv="slider"], .audioflix-volume-slider, .audioflix-provider-volume'
        );
        if (!slider) return;
        const isSharedTransportSlider = slider.matches(
            '.audioflix-volume-slider, .audioflix-provider-volume'
        );
        const level = clamp(slider.value);
        const audio = window.EveAudioflixAudio;
        const activeId = audio?.getPlaybackState?.()?.item?.id;
        if (activeId != null && typeof audio?.updateItemVolume === 'function') {
            audio.updateItemVolume(activeId, level);
        } else {
            setSpotifyVolume(level);
        }
        document.querySelectorAll('.audioflix-volume-slider').forEach((card) => {
            if (String(card.dataset.afId) !== String(activeId)) return;
            card.value = String(level);
            card.style.setProperty('--vol', `${level * 100}%`);
            const label = card.parentElement?.querySelector('.audioflix-volume-label');
            if (label) label.textContent = `${Math.round(level * 100)}%`;
        });
        // The shared slider's normal Audioflix handler runs later in the same input event and calls
        // the Spotify controller. Defer fallback selection to a microtask so that direct controller
        // ownership wins without opening an unnecessary capture picker.
        queueMicrotask(() => {
            if (!state.spotifyActive || state.directControl || snapshot().active
                || state.status === 'starting') return;
            void enable();
        });
    });

    window.EveAudioflixSpotifyVolume = {
        enable,
        disable,
        setSpotifyVolume,
        clearSpotify,
        applyCapturePolicy,
        mount,
        snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
})();
