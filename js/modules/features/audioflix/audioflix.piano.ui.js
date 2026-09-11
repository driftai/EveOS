window.EveAudioflixPianoUi = window.EveAudioflixPianoUi || {};

(function (ns) {
    'use strict';
    if (ns.ready) return;

    let visible = false;
    let pollTimer = 0;
    let root = null;
    let detachedWindow = null;
    let detachedTimer = 0;

    function snapshot() {
        return window.EveAudioflixPiano?.state || {};
    }

    function isDetached() {
        return Boolean(detachedWindow && !detachedWindow.closed);
    }

    function context() {
        const audioflix = window.EveAudioflixState?.getSnapshot?.() || {};
        const route = audioflix.nativeBridgeEnabled && audioflix.nativeOutputLabel
            ? audioflix.nativeOutputLabel : (audioflix.preferredSinkLabel || 'Default output');
        return {
            surface: 'Audioflix',
            soundCount: Number(audioflix.soundboard?.length || 0),
            musicCount: Number(audioflix.music?.length || 0),
            outputRoute: route,
            sentAt: new Date().toISOString()
        };
    }

    function sendContext(frame) {
        try {
            frame?.contentWindow?.postMessage({ type: 'eveos:audioflix-context', context: context() }, '*');
        } catch (_) {}
    }

    function watchDetached() {
        if (detachedTimer) clearInterval(detachedTimer);
        if (!isDetached()) {
            detachedTimer = 0;
            detachedWindow = null;
            patch();
            return;
        }
        detachedTimer = setInterval(() => {
            if (isDetached()) return;
            clearInterval(detachedTimer);
            detachedTimer = 0;
            detachedWindow = null;
            patch();
        }, 700);
    }

    function patch(host = root) {
        const panel = host?.querySelector?.('[data-audioflix-piano]');
        if (!panel) return;
        const status = snapshot();
        const running = status.running === true;
        const selecting = status.phase === 'selecting';
        const detached = isDetached();
        const pill = panel.querySelector('[data-piano-status]');
        const message = panel.querySelector('[data-piano-message]');
        const toggle = panel.querySelector('[data-piano-toggle]');
        const detachButton = panel.querySelector('[data-af-action="piano-detach"]');
        const frame = panel.querySelector('[data-piano-frame]');
        const offline = panel.querySelector('[data-piano-offline]');
        const detachedOverlay = panel.querySelector('[data-piano-detached]');
        const setupState = panel.querySelector('[data-piano-setup-state]');
        panel.classList.toggle('is-detached', detached);
        panel.dataset.running = running ? 'true' : 'false';
        panel.dataset.exposure = status.exposureMode || 'local';
        if (pill) {
            pill.dataset.state = status.phase || 'stopped';
            pill.textContent = running
                ? (status.exposureMode && status.exposureMode !== 'local' ? `Online · ${status.exposureMode}` : 'Online')
                : selecting ? 'Choosing mode' : status.phase === 'starting' ? 'Starting' : 'Stopped';
        }
        if (message) message.textContent = detached
            ? 'Detached Piano window is active. The embedded player is paused for interaction until that window closes.'
            : (status.message || '');
        if (toggle) {
            toggle.textContent = selecting ? 'Choose mode in terminal…' : running ? 'Stop Piano' : 'Start Piano';
            toggle.disabled = status.busy === true || status.installed === false || selecting || (running && status.controllerAvailable === false);
            toggle.title = running && status.controllerAvailable === false
                ? 'This Piano share is visible here, but lifecycle controls stay on the host PC.'
                : '';
        }
        if (detachButton) {
            detachButton.textContent = detached ? 'Focus Detached' : 'Detach';
            detachButton.disabled = !running;
        }
        if (frame) {
            frame.hidden = !running;
            const source = running ? (status.url || window.EveAudioflixPiano.serviceUrl()) : 'about:blank';
            if (frame.getAttribute('src') !== source) frame.setAttribute('src', source);
            if (running && !detached) sendContext(frame);
        }
        if (offline) offline.hidden = running;
        if (detachedOverlay) detachedOverlay.hidden = !detached;
        if (setupState) {
            const conversion = status.youtubeSetup ? 'Media conversion installed' : 'Media conversion optional';
            const hifi = status.hifiSetup ? 'Hi-Fi installed' : 'Hi-Fi optional';
            setupState.textContent = selecting
                ? 'Waiting for Localhost / LAN / Cloudflare selection in terminal'
                : `Core ready - ${conversion} - ${hifi}`;
        }
    }

    async function refresh() {
        await window.EveAudioflixPiano?.refresh?.();
        patch();
    }

    function syncPoll() {
        if (pollTimer && !visible) {
            clearInterval(pollTimer);
            pollTimer = 0;
        }
        if (!pollTimer && visible) pollTimer = setInterval(() => void refresh(), 5000);
    }

    function setVisible(next) {
        visible = next === true;
        syncPoll();
        if (visible) void refresh();
    }

    function afterRender(host) {
        root = host;
        const frame = root?.querySelector?.('[data-piano-frame]');
        frame?.addEventListener('load', () => sendContext(frame), { once: true });
        patch(host);
    }

    function render() {
        const status = snapshot();
        const running = status.running === true;
        const selecting = status.phase === 'selecting';
        return `<section class="audioflix-piano" data-audioflix-piano>
            <header class="audioflix-piano-header"><div><span>PIANO AUTOMATION</span><h3>Piano-Auto-Player</h3><p>Search sheets, record exact performances, audition internally, or send timed keys to a selected piano window.</p></div><div class="audioflix-piano-actions"><b data-piano-status data-state="${status.phase || 'checking'}">${running ? 'Online' : selecting ? 'Choosing mode' : 'Checking'}</b><button type="button" data-af-action="piano-refresh">Refresh</button><button type="button" data-af-action="piano-setup">Setup / Repair</button><button type="button" data-af-action="piano-toggle" data-piano-toggle>${selecting ? 'Choose mode in terminal…' : running ? 'Stop Piano' : 'Start Piano'}</button><button type="button" data-af-action="piano-detach">Detach</button></div></header>
            <p class="audioflix-piano-message" data-piano-message>${status.message || 'Checking the local Piano service...'}</p>
            <div class="audioflix-piano-stage">
                <iframe data-piano-frame title="Piano Auto Player" src="${running ? status.url : 'about:blank'}" ${running ? '' : 'hidden'}></iframe>
                <div class="audioflix-piano-detached" data-piano-detached hidden><strong>Detached Piano window active</strong><span>This embedded copy is dimmed and interaction-locked so the detached window is the primary Piano workspace.</span><button type="button" data-af-action="piano-refocus">Focus detached window</button></div>
                <div class="audioflix-piano-offline" data-piano-offline ${running ? 'hidden' : ''}><strong>${selecting ? 'Choose Piano exposure mode' : 'Piano is resting'}</strong><span>${selecting ? 'Use the terminal that just opened to choose Localhost, LAN, or Cloudflare Router.' : 'Start it only when you want sheet playback, recording, or conversion tools.'}</span><small data-piano-setup-state>${selecting ? 'Waiting for terminal selection' : 'Core ready - optional engines not checked'}</small><div><button type="button" data-af-action="piano-toggle">${selecting ? 'Choose mode in terminal…' : 'Start Piano-Auto-Player'}</button><button type="button" data-af-action="piano-setup">Setup / Repair</button></div></div>
            </div>
        </section>`;
    }

    function renderDetachedMessage(target, message) {
        if (!target || target.closed) return;
        target.document.body.innerHTML = '';
        target.document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#081214;color:#efffd0;font:16px sans-serif';
        const text = target.document.createElement('p');
        text.textContent = message;
        target.document.body.appendChild(text);
    }

    async function detach() {
        if (isDetached()) {
            detachedWindow.focus();
            patch();
            return;
        }
        let status = snapshot();
        if (!status.running) {
            await window.EveAudioflixPiano.start();
            status = snapshot();
            if (status.phase === 'selecting') {
                patch();
                return;
            }
        }
        if (!status.running) return;
        const target = window.open('about:blank', 'eveos-piano-auto-player', 'popup=yes,width=1320,height=900,resizable=yes,scrollbars=yes');
        if (!target) return;
        detachedWindow = target;
        watchDetached();
        patch();
        renderDetachedMessage(target, 'Opening Piano-Auto-Player...');
        target.location.replace(status.url || window.EveAudioflixPiano.serviceUrl());
        target.focus();
    }

    async function handleAction(target) {
        const action = target?.dataset?.afAction || '';
        if (action === 'piano-refresh') await refresh();
        if (action === 'piano-toggle') {
            const status = snapshot();
            if (status.phase === 'selecting') return { handled: true };
            await (status.running ? window.EveAudioflixPiano.stop() : window.EveAudioflixPiano.start());
            patch();
        }
        if (action === 'piano-setup') {
            await window.EveAudioflixPiano.setup();
            patch();
        }
        if (action === 'piano-detach') await detach();
        if (action === 'piano-refocus') {
            if (isDetached()) detachedWindow.focus(); else await detach();
        }
        return { handled: action.startsWith('piano-') };
    }

    window.addEventListener('message', (event) => {
        if (event.data?.type === 'piano:eveos-ready') {
            sendContext(root?.querySelector?.('[data-piano-frame]'));
        }
    });
    window.addEventListener('eve:audioflix-piano-status', () => patch());
    Object.assign(ns, { ready: true, render, afterRender, setVisible, handleAction });
})(window.EveAudioflixPianoUi);