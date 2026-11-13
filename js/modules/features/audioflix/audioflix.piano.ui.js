window.EveAudioflixPianoUi = window.EveAudioflixPianoUi || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    let visible = false;
    let pollTimer = 0;
    let root = null;
    let detachedWindow = null;
    let detachedTimer = 0;
    let outputRoute = null;
    let pcmRoute = null;
    let pianoTransport = 'native-pcm';
    // Server-owned playback is the default for new users. Explicit Browser PCM choices
    // survive a page reload; no preference ever overrides a running native session.
    const enginePreferenceKey = 'eveos:piano:internal-engine:v1';
    let serverOwnedChoice = (() => {
        try { return localStorage.getItem(enginePreferenceKey) !== 'browser'; }
        catch (_) { return true; }
    })();
    const nativeToken = [...crypto.getRandomValues(new Uint8Array(24))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
    const contextSignatures = new WeakMap();
    function snapshot() {
        return window.EveAudioflixPiano?.state || {};
    }
    function isDetached() {
        return Boolean(detachedWindow && !detachedWindow.closed);
    }
    function context() {
        const audioflix = window.EveAudioflixState?.getSnapshot?.() || {};
        const route = audioflix.preferredSinkLabel || (audioflix.nativeBridgeEnabled && audioflix.nativeOutputLabel) || 'Default output';
        return {
            surface: 'Audioflix',
            soundCount: Number(audioflix.soundboard?.length || 0),
            musicCount: Number(audioflix.music?.length || 0),
            outputRoute: route,
            audioOutput: { requestedLabel: route, browserSinkId: audioflix.preferredSinkId || '', source: audioflix.preferredSinkId ? 'browser-selective' : (audioflix.nativeBridgeEnabled ? 'native-match' : 'browser') },
            pianoNative: { available: audioflix.nativeBridgeEnabled === true
                && String(audioflix.nativeOutputId || '').startsWith('sd:')
                && window.EveAudioflixPianoNative?.ready === true,
                token: nativeToken, preferred: serverOwnedChoice },
            sentAt: new Date().toISOString()
        };
    }
    function targetDetails(value) {
        // WindowProxy turns cross-origin on Detach: never read iframe-only properties from it.
        const isFrame = typeof HTMLIFrameElement !== 'undefined' && value instanceof HTMLIFrameElement;
        const target = isFrame ? value.contentWindow : value;
        if (!target) return null;
        const source = isFrame ? value.getAttribute('src') : snapshot().url;
        if (!source) return null;
        try { return { target, origin: new URL(source, window.location.href).origin,
            frame: isFrame ? value : null, source }; }
        catch (_) { return null; }
    }
    async function sendContext(frame, options = {}) {
        const destination = targetDetails(frame);
        if (!destination || destination.origin === 'null') return false;
        // A new iframe initially retains the EveOS about:blank origin until navigation commits.
        // Cross-origin frames have null contentDocument; defer authorization until then.
        if (destination.frame?.contentDocument && destination.origin !== window.location.origin) return false;
        const initial = context();
        const routeState = window.EveAudioflixState?.getSnapshot?.() || {};
        const preferBrowserDirect = options.preferBrowserDirect === true;
        const signature = JSON.stringify({ origin: destination.origin, route: initial.outputRoute,
            sink: initial.audioOutput.browserSinkId, native: routeState.nativeBridgeEnabled === true,
            nativeId: routeState.nativeOutputId || '',
            nativeReady: initial.pianoNative.available, nativePreferred: serverOwnedChoice,
            sessionActive: Boolean(window.EveAudioflixPianoNative?.snapshot?.()?.sessionId),
            transport: preferBrowserDirect ? 'browser-direct' : 'native-pcm' });
        if (options.force !== true && options.retry !== true && contextSignatures.get(destination.target) === signature) return true;
        try {
            const sink = await Promise.resolve(window.EveAudioflixAudio?.resolvePlaybackSink?.()).catch(() => null);
            const useBrowserDirect = preferBrowserDirect && Boolean(sink?.deviceId);
            // Once server-owned playback begins, do not resurrect the browser PCM lane
            // during a context refresh; that can race the selected native renderer.
            const serverOwnedActive = Boolean(window.EveAudioflixPianoNative?.snapshot?.()?.sessionId);
            const pianoPcm = serverOwnedActive
                ? { requested: false, active: false, transport: 'server-owned' }
                : useBrowserDirect
                ? await Promise.resolve(window.EveAudioflixPianoPcm?.revoke?.(destination.target))
                    .then(() => ({ requested: false, active: false, transport: 'browser-direct' }))
                : await window.EveAudioflixPianoPcm?.authorize?.(destination.target, destination.origin, options)
                    .catch(error => ({ requested: true, active: false, error: String(error?.message || error) }));
            const refined = { ...context(), audioOutput: { requestedLabel: initial.audioOutput.requestedLabel,
                browserSinkId: String(sink?.deviceId || ''), source: sink?.source || initial.audioOutput.source },
                pianoPcm: pianoPcm || { requested: false, active: false } };
            // Avoid posting to a frame that changed sources during asynchronous authorization.
            if (destination.frame && (destination.frame.contentWindow !== destination.target
                || destination.frame.getAttribute('src') !== destination.source)) return false;
            if (destination.frame?.contentDocument && destination.origin !== window.location.origin) return false;
            destination.target.postMessage({ type: 'eveos:audioflix-context', context: refined }, destination.origin);
            pianoTransport = useBrowserDirect ? 'browser-direct' : 'native-pcm';
            contextSignatures.set(destination.target, signature);
            return true;
        } catch (_) { return false; }
    }
    function outputRouteStatus() { return outputRoute ? { ...outputRoute } : null; }
    function renderOutputRouteCard() {
        const esc = value => String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        const current = outputRouteStatus(), audioflix = window.EveAudioflixState?.getSnapshot?.() || {};
        const requested = audioflix.preferredSinkLabel || (audioflix.nativeBridgeEnabled && audioflix.nativeOutputLabel) || 'System default output';
        if (audioflix.nativeBridgeEnabled && String(audioflix.nativeOutputId || '').startsWith('sd:')
            && !(pianoTransport === 'browser-direct' && current?.applied === true)) {
            const active = pcmRoute?.status === 'active', failed = pcmRoute?.status === 'failed';
            const reconnecting = pcmRoute?.status === 'recovering';
            const title = active ? (audioflix.nativeOutputLabel || audioflix.nativeOutputId)
                : reconnecting ? 'Reconnecting Piano PCM…'
                : failed ? 'Piano PCM route stopped safely' : 'Preparing Piano PCM route…';
            const detail = active ? `Post-compressor Piano PCM is isolated on its own native lane. ${pcmRoute.metrics?.medianMs || 0} ms median transport. ${pcmRoute.metrics?.dropped || 0} dropped.`
                : reconnecting ? 'Native transport interrupted; bounded retries are in progress. Browser fallback stays muted.'
                : failed ? (pcmRoute.message || 'The selected native endpoint refused Piano PCM; browser fallback remains muted.')
                    : 'Opening the exact selected native endpoint without interrupting Spotify.';
            return `<article class="audioflix-status-card ${active ? 'is-on' : ''}"><span>Piano Native PCM</span><strong>${esc(title)}</strong><p>${esc(detail)}</p></article>`;
        }
        const ready = current?.applied === true, waiting = !current;
        const title = ready ? (current.label || requested) : waiting ? 'Checking Piano output…' : 'Default output — route not applied';
        const detail = ready ? 'Piano WebAudio is using this browser-authorized output.' : 'Piano is browser WebAudio. Grant/select the same browser output as the Native Bridge to send it through that port.';
        return `<article class="audioflix-status-card ${ready ? 'is-on' : ''}"><span>Piano WebAudio</span><strong>${esc(title)}</strong><p>${esc(detail)}</p>${ready ? '' : '<button type="button" data-af-action="route-piano-output">Route Piano to selected port</button>'}</article>`;
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
            if (running && !detached) void sendContext(frame);
            if (!running) void window.EveAudioflixPianoPcm?.revoke?.();
        }
        if (offline) offline.hidden = running;
        if (detachedOverlay) detachedOverlay.hidden = !detached;
        window.EveAudioflixPianoViews?.apply?.(panel);
        window.EveAudioflixPianoFrontend?.sync?.(host);
        window.EveAudioflixPianoFrontendPorts?.syncEngine?.();
        if (setupState) {
            const conversion = status.youtubeSetup ? 'Media conversion installed' : 'Media conversion optional';
            const hifi = status.hifiSetup ? 'Hi-Fi installed' : 'Hi-Fi optional';
            setupState.textContent = selecting
                ? 'Waiting for Localhost / LAN / Cloudflare selection in terminal'
                : `Core ready - ${conversion} - ${hifi}`;
        }
    }
    function reloadWorkspace() {
        const destination = targetDetails(isDetached()
            ? detachedWindow
            : root?.querySelector?.('[data-piano-frame]'));
        if (!destination || destination.origin === 'null') return false;
        window.EveAudioflixPianoFrontend?.invalidate?.();
        window.EveAudioflixPianoFrontendPorts?.invalidate?.();
        destination.target.postMessage({ type: 'eveos:piano-refresh' }, destination.origin);
        return true;
    }
    async function refresh({ reloadWorkspace: shouldReloadWorkspace = false, retryPcm = false } = {}) {
        await window.EveAudioflixPiano?.refresh?.();
        patch();
        if (retryPcm && snapshot().running) {
            const target = isDetached() ? detachedWindow : root?.querySelector?.('[data-piano-frame]');
            if (target) await sendContext(target, { retry: true });
        }
        if (shouldReloadWorkspace && snapshot().running) reloadWorkspace();
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
        if (frame && frame.dataset.pianoContextBound !== 'yes') {
            frame.dataset.pianoContextBound = 'yes';
            frame.addEventListener('load', () => {
                contextSignatures.delete(frame.contentWindow);
                void sendContext(frame, { force: true });
                window.EveAudioflixPianoFrontend?.refresh?.(true);
            });
        }
        window.EveAudioflixPianoFrontend?.mount?.(host);
        patch(host);
    }

    function render() {
        const status = snapshot();
        const running = status.running === true;
        const selecting = status.phase === 'selecting';
        return `<section class="audioflix-piano" data-audioflix-piano>
            <header class="audioflix-piano-header"><div><span>PIANO AUTOMATION</span><h3 data-piano-view-title>Piano Auto Player - Backend</h3><p>Search sheets, record exact performances, audition internally, or send timed keys to a selected piano window.</p></div><div class="audioflix-piano-actions"><b data-piano-status data-state="${status.phase || 'checking'}">${running ? 'Online' : selecting ? 'Choosing mode' : 'Checking'}</b><button type="button" data-af-action="piano-refresh">Refresh</button><button type="button" data-af-action="piano-setup">Setup / Repair</button><button type="button" data-af-action="piano-toggle" data-piano-toggle>${selecting ? 'Choose mode in terminal…' : running ? 'Stop Piano' : 'Start Piano'}</button><button type="button" data-af-action="piano-detach">Detach</button></div></header>
            <div class="audioflix-piano-meta"><p class="audioflix-piano-message" data-piano-message>${status.message || 'Checking the local Piano service...'}</p><button type="button" class="audioflix-piano-view-switch" data-af-action="piano-view-switch" data-piano-view-switch aria-label="Switch Piano view">Frontend</button></div>
            <div class="audioflix-piano-stage">
                <div class="audioflix-piano-backend" data-piano-backend aria-hidden="false">
                <iframe data-piano-frame title="Piano Auto Player" allow="autoplay" src="${running ? status.url : 'about:blank'}" ${running ? '' : 'hidden'}></iframe>
                <div class="audioflix-piano-detached" data-piano-detached hidden><strong>Detached Piano window active</strong><span>This embedded copy is dimmed and interaction-locked so the detached window is the primary Piano workspace.</span><button type="button" data-af-action="piano-refocus">Focus detached window</button></div>
                <div class="audioflix-piano-offline" data-piano-offline ${running ? 'hidden' : ''}><strong>${selecting ? 'Choose Piano exposure mode' : 'Piano is resting'}</strong><span>${selecting ? 'Use the terminal that just opened to choose Localhost, LAN, or Cloudflare Router.' : 'Start it only when you want sheet playback, recording, or conversion tools.'}</span><small data-piano-setup-state>${selecting ? 'Waiting for terminal selection' : 'Core ready - optional engines not checked'}</small><div><button type="button" data-af-action="piano-toggle">${selecting ? 'Choose mode in terminal…' : 'Start Piano-Auto-Player'}</button><button type="button" data-af-action="piano-setup">Setup / Repair</button></div></div>
                </div>
                <div class="audioflix-piano-frontend" data-piano-frontend role="region" aria-label="Piano library and player" hidden></div>
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
        const destination = new URL(status.url || window.EveAudioflixPiano.serviceUrl());
        destination.searchParams.set('eveosDetached', '1');
        target.location.replace(destination.toString());
        target.focus();
    }

    function reattach() {
        const target = detachedWindow;
        if (!target || target.closed) return false;
        if (detachedTimer) clearInterval(detachedTimer);
        detachedTimer = 0;
        detachedWindow = null;
        try { target.close(); } catch (_) {}
        if (window.EveAudioflix) {
            window.EveAudioflix.activeTab = 'piano';
            window.EveAudioflix.open?.();
            window.EveAudioflix.render?.();
        }
        patch();
        setTimeout(() => root?.querySelector?.('[data-piano-frame]')?.focus(), 0);
        return true;
    }

    function engineChoice() {
        const audio = window.EveAudioflixState?.getSnapshot?.() || {};
        const available = audio.nativeBridgeEnabled === true
            && String(audio.nativeOutputId || '').startsWith('sd:')
            && window.EveAudioflixPianoNative?.ready === true;
        const attached = Boolean(window.EveAudioflixPianoNative?.snapshot?.()?.sessionId);
        return { selected: attached || serverOwnedChoice ? 'server' : 'browser', available, attached,
            message: attached ? 'Playing from the server-owned Piano engine. Stop before switching.'
                : !available && serverOwnedChoice ? 'Start the native bridge and select an output under AudioFlix Audio Output / Voice Port.'
                : serverOwnedChoice ? 'Native playback runs independently of the browser.'
                : 'Browser PCM can become choppy when EveOS is minimized.' };
    }
    async function chooseEngine(native) {
        const wanted = native === true;
        if (!wanted && window.EveAudioflixPianoNative?.snapshot?.()?.sessionId)
            return { ok: false, message: 'Stop the server-owned Piano song before switching to Browser PCM.' };
        serverOwnedChoice = wanted;
        try { localStorage.setItem(enginePreferenceKey, wanted ? 'server' : 'browser'); } catch (_) {}
        const target = isDetached() ? detachedWindow : root?.querySelector?.('[data-piano-frame]');
        if (target) await sendContext(target, { force: true });
        patch();
        return { ok: true, selected: wanted ? 'server' : 'browser' };
    }
    async function handleAction(target) {
        const action = target?.dataset?.afAction || '';
        if (action === 'piano-native-mode-toggle') {
            await chooseEngine(!serverOwnedChoice);
            return { handled: true };
        }
        if (action === 'piano-view-switch') {
            window.EveAudioflixPianoViews?.toggle?.(root?.querySelector?.('[data-audioflix-piano]'));
            window.EveAudioflixPianoFrontend?.sync?.(root);
            return { handled: true };
        }
        if (action.startsWith('piano-frontend-')) return { handled: window.EveAudioflixPianoFrontend?.handleAction?.(target) === true };
        if (action === 'piano-refresh') await refresh({ reloadWorkspace: true, retryPcm: true });
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
        if (event.data?.type === 'piano:eveos-reattach-request' && event.source === detachedWindow) {
            reattach();
            return;
        }
        if (event.data?.type === 'piano:eveos-ready') {
            const embedded = root?.querySelector?.('[data-piano-frame]');
            if (event.source === detachedWindow && event.origin === targetDetails(detachedWindow)?.origin)
                void sendContext(detachedWindow, { force: true });
            else if (event.source === embedded?.contentWindow && event.origin === targetDetails(embedded)?.origin)
                void sendContext(embedded, { force: true });
        }
        if (event.data?.type === 'piano:eveos-engine-choice') {
            const embedded = root?.querySelector?.('[data-piano-frame]');
            const trusted = (event.source === embedded?.contentWindow && event.origin === targetDetails(embedded)?.origin)
                || (event.source === detachedWindow && event.origin === targetDetails(detachedWindow)?.origin);
            if (!trusted || typeof event.data.nativePreferred !== 'boolean') return;
            void chooseEngine(event.data.nativePreferred);
            return;
        }
        if (event.data?.type === 'piano:eveos-native-request') {
            const frame = root?.querySelector?.('[data-piano-frame]')?.contentWindow;
            const trusted = event.source === frame || event.source === detachedWindow;
            if (!trusted || event.data.token !== nativeToken || !window.EveAudioflixPianoNative?.ready) return;
            const action = String(event.data.action || 'status');
            const fn = window.EveAudioflixPianoNative[action];
            Promise.resolve(typeof fn === 'function' ? fn(event.data.payload) : Promise.reject(new Error('Unknown Piano native action.')))
                .then(result => event.source?.postMessage?.({ type: 'piano:eveos-native-response',
                    requestId: event.data.requestId, ok: true, result }, event.origin))
                .catch(error => event.source?.postMessage?.({ type: 'piano:eveos-native-response',
                    requestId: event.data.requestId, ok: false, message: String(error?.message || error) }, event.origin));
            return;
        }
        if (event.data?.type === 'piano:eveos-audio-route') {
            const frame = root?.querySelector?.('[data-piano-frame]')?.contentWindow;
            if (event.source !== frame && event.source !== detachedWindow) return;
            const next = event.data.route && typeof event.data.route === 'object' ? event.data.route : null;
            if (JSON.stringify(next) !== JSON.stringify(outputRoute)) { outputRoute = next; window.EveAudioflix?.render?.(); }
            const current = window.EveAudioflixState?.getSnapshot?.() || {};
            if (current.nativeBridgeEnabled === true && String(current.nativeOutputId || '').startsWith('sd:')) {
                const target = event.source === detachedWindow ? detachedWindow : root?.querySelector?.('[data-piano-frame]');
                if (next?.applied === true && next?.sinkId && pianoTransport !== 'browser-direct')
                    void sendContext(target, { force: true, preferBrowserDirect: true });
                else if (next?.applied !== true && pianoTransport === 'browser-direct')
                    void sendContext(target, { force: true });
            }
        }
    });
    // AudioFlix may build its iframe before deferred native JS finishes loading.
    // Re-issue its authenticated context when that module becomes ready.
    const resyncNative = () => {
        const target = isDetached() ? detachedWindow : root?.querySelector?.('[data-piano-frame]');
        if (snapshot().running && target) void sendContext(target, { force: true });
        patch();
    };
    window.addEventListener('eve:audioflix-piano-native-session', resyncNative);
    window.addEventListener('eve:audioflix-piano-native-ready', resyncNative);
    window.addEventListener('eve:audioflix-piano-status', () => patch());
    window.addEventListener('eve:audioflix-piano-pcm', event => {
        const previous = pcmRoute?.status;
        pcmRoute = event.detail && typeof event.detail === 'object' ? event.detail : null;
        // After a failed first open the child worklet was never armed; re-send the same
        // owner context on recovery rather than switching to browser speaker output.
        if (previous === 'recovering' && pcmRoute?.status === 'active' && snapshot().running) {
            const target = isDetached() ? detachedWindow : root?.querySelector?.('[data-piano-frame]');
            if (target) void sendContext(target, { force: true });
        }
        window.EveAudioflix?.render?.();
    });
    Object.assign(ns, { ready: true, render, afterRender, setVisible, handleAction, reattach,
        outputRouteStatus, pcmRouteStatus: () => pcmRoute ? { ...pcmRoute } : null,
        renderOutputRouteCard, engineChoice, chooseEngine });
})(window.EveAudioflixPianoUi);
