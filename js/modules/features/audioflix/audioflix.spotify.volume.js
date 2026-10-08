/* Audioflix: Spotify embed volume without an extension.
 *
 * Spotify's iFrame API has no volume method, and the embed is cross-origin, so the page cannot
 * touch its audio element. Chrome can, however, let a page capture its own tab's audio
 * (getDisplayMedia + preferCurrentTab) and stop that audio from playing locally
 * (suppressLocalAudioPlayback). The captured audio is then replayed through a GainNode.
 *
 * Suppression silences everything the captured tab outputs, including Web Audio played by this
 * page, so the replay must run in a separate same-origin window ("AudioFlix sound output").
 * Closing that window or Chrome's "Stop sharing" ends the capture and restores normal audio.
 *
 * Gain follows the playing Spotify embed only; any other source plays back at unity so its own
 * element volume is never applied twice.
 */
(function () {
    'use strict';

    const OUTPUT_WINDOW = 'eveos_audioflix_sound_output';
    const state = {
        stream: null,
        output: null,       // helper window
        context: null,      // AudioContext owned by the helper window
        gain: null,
        spotifyActive: false,
        spotifyVolume: 1,
        status: 'off',      // off | starting | on | needs-click | error
        message: '',
        tabLabel: ''
    };
    const listeners = new Set();

    const clamp = (v) => Math.max(0, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : 1));
    const supported = () => !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
    const targetGain = () => (state.spotifyActive ? state.spotifyVolume : 1);

    function snapshot() {
        return {
            supported: supported(),
            status: state.status,
            message: state.message,
            active: state.status === 'on' || state.status === 'needs-click',
            spotifyActive: state.spotifyActive,
            volume: state.spotifyVolume,
            gain: targetGain(),
            tabLabel: state.tabLabel
        };
    }

    function notify() {
        const snap = snapshot();
        listeners.forEach((fn) => { try { fn(snap); } catch { } });
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
            + '<div>AudioFlix is playing EveOS sound through this window.</div>'
            + '<div style="opacity:.7">Keep it open. Close it to turn volume control off.</div>'
            + '<button id="afStart" hidden style="padding:6px 14px">Click to start sound</button></body>');
        doc.close();
    }

    function connectInOutput(win, stream) {
        const Ctx = win.AudioContext || win.webkitAudioContext;
        if (!Ctx) throw new Error('This browser cannot play captured audio.');
        const context = new Ctx({ latencyHint: 'playback' });
        let source;
        try {
            source = context.createMediaStreamSource(stream);
        } catch {
            // Some engines reject a stream created in another window; rewrap its tracks there.
            source = context.createMediaStreamSource(new win.MediaStream(stream.getAudioTracks()));
        }
        const gain = context.createGain();
        gain.gain.value = targetGain();
        source.connect(gain).connect(context.destination);
        return { context, gain };
    }

    async function enable() {
        if (state.status === 'on' || state.status === 'starting') return snapshot();
        if (!supported()) {
            state.status = 'error';
            state.message = 'This browser cannot share tab audio.';
            notify();
            return snapshot();
        }
        state.status = 'starting';
        state.message = 'Choose "This tab" and keep "Also share tab audio" on.';
        notify();
        // Must open synchronously inside the click, before any await, or the popup is blocked.
        const win = window.open('', OUTPUT_WINDOW, 'width=360,height=150');
        if (!win) {
            state.status = 'error';
            state.message = 'Allow pop-ups for EveOS. Sound plays through a small helper window.';
            notify();
            return snapshot();
        }
        try {
            writeOutputWindow(win);
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { max: 1 } },
                audio: {
                    suppressLocalAudioPlayback: true,
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
                stream.getTracks().forEach((t) => t.stop());
                throw new Error('No tab audio was shared. Turn on "Also share tab audio" and try again.');
            }
            stream.getVideoTracks().forEach((t) => { t.enabled = false; });
            const { context, gain } = connectInOutput(win, stream);
            Object.assign(state, { stream, output: win, context, gain, tabLabel: document.title || 'EveOS' });
            stream.getTracks().forEach((t) => t.addEventListener('ended', () => disable('Tab sharing stopped.'), { once: true }));
            win.addEventListener('pagehide', () => disable('Sound window closed.'), { once: true });
            const settings = audioTrack.getSettings?.() || {};
            const surface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface;
            await context.resume().catch(() => { });
            if (context.state !== 'running') {
                state.status = 'needs-click';
                state.message = 'Click "Click to start sound" in the AudioFlix sound window.';
                const btn = win.document.getElementById('afStart');
                if (btn) {
                    btn.hidden = false;
                    btn.addEventListener('click', async () => {
                        await context.resume().catch(() => { });
                        if (context.state === 'running') { btn.hidden = true; state.status = 'on'; state.message = ''; notify(); }
                    });
                }
            } else {
                state.status = 'on';
                state.message = '';
            }
            if (surface && surface !== 'browser') state.message = 'Share a browser tab (EveOS) for volume control.';
            else if (settings.suppressLocalAudioPlayback === false) state.message = 'Chrome is still playing the tab directly; volume may stack.';
            applyGain();
        } catch (error) {
            try { win.close(); } catch { }
            teardown();
            state.status = error?.name === 'NotAllowedError' ? 'off' : 'error';
            state.message = error?.name === 'NotAllowedError' ? '' : (error?.message || 'Volume control could not start.');
        }
        notify();
        return snapshot();
    }

    function teardown() {
        const { stream, context, output } = state;
        Object.assign(state, { stream: null, context: null, gain: null, output: null, tabLabel: '' });
        try { stream?.getTracks().forEach((t) => t.stop()); } catch { }
        try { context?.close(); } catch { }
        try { if (output && !output.closed) output.close(); } catch { }
    }

    function disable(message = '') {
        if (state.status === 'off' && !state.stream) return snapshot();
        teardown();
        state.status = 'off';
        state.message = message;
        notify();
        return snapshot();
    }

    // Called by the Spotify player adapter.
    function setSpotifyVolume(volume) {
        state.spotifyActive = true;
        state.spotifyVolume = clamp(volume);
        applyGain();
        notify();
    }

    function clearSpotify() {
        if (!state.spotifyActive) return;
        state.spotifyActive = false;
        applyGain();
        notify();
    }

    // ---- UI: a small bar under the Spotify embed in the AudioFlix player ----
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function barHtml() {
        const s = snapshot();
        if (!s.supported) return '<div class="af-spv-row"><span class="af-spv-note">Volume control needs Chrome or Edge.</span></div>';
        const on = s.active;
        const pct = Math.round(s.volume * 100);
        return `<div class="af-spv-row">`
            + `<button type="button" class="af-spv-toggle" data-af-spv="toggle" ${s.status === 'starting' ? 'disabled' : ''}>${on ? 'Stop volume control' : 'Enable volume control'}</button>`
            + `<input type="range" class="af-spv-slider" data-af-spv="slider" min="0" max="1" step="0.01" value="${s.volume}" ${on ? '' : 'disabled'} aria-label="Spotify volume">`
            + `<span class="af-spv-pct">${pct}%</span></div>`
            + `<div class="af-spv-meta">${on ? `Controlling: ${esc(s.tabLabel)} (this tab)` : 'Spotify embeds have no volume of their own; this shares this tab\u2019s sound with AudioFlix.'}</div>`
            + (s.message ? `<div class="af-spv-note">${esc(s.message)}</div>` : '');
    }

    function renderAll() {
        document.querySelectorAll('.af-spotify-volume').forEach((el) => {
            const slider = el.querySelector('[data-af-spv="slider"]');
            if (slider && document.activeElement === slider) {
                el.querySelector('.af-spv-pct').textContent = `${Math.round(state.spotifyVolume * 100)}%`;
                return;
            }
            el.innerHTML = barHtml();
        });
    }

    function mount(host) {
        if (!host) return null;
        let el = host.querySelector(':scope > .af-spotify-volume');
        if (!el) {
            el = document.createElement('div');
            el.className = 'af-spotify-volume';
            el.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:6px 2px;font-size:12px';
            host.appendChild(el);
        }
        el.innerHTML = barHtml();
        return el;
    }

    document.addEventListener('click', (event) => {
        const btn = event.target?.closest?.('[data-af-spv="toggle"]');
        if (!btn) return;
        if (snapshot().active) disable(); else enable();
    });
    document.addEventListener('input', (event) => {
        const slider = event.target?.closest?.('[data-af-spv="slider"]');
        if (!slider) return;
        const level = clamp(slider.value);
        // Route through the normal transport so the card slider and saved item volume stay in sync.
        const audio = window.EveAudioflixAudio;
        const activeId = audio?.getPlaybackState?.()?.item?.id;
        if (activeId != null && typeof audio?.updateItemVolume === 'function') audio.updateItemVolume(activeId, level);
        else setSpotifyVolume(level);
        document.querySelectorAll('.audioflix-volume-slider').forEach((card) => {
            if (String(card.dataset.afId) !== String(activeId)) return;
            card.value = String(level);
            card.style.setProperty('--vol', `${level * 100}%`);
            const label = card.parentElement?.querySelector('.audioflix-volume-label');
            if (label) label.textContent = `${Math.round(level * 100)}%`;
        });
    });

    window.EveAudioflixSpotifyVolume = {
        enable, disable, setSpotifyVolume, clearSpotify, mount, snapshot,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    };
})();
