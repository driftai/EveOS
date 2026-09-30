window.EveAudioflixInternalPlayer = window.EveAudioflixInternalPlayer || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixInternalPlayer;
    if (ns.ready) return;

    const HOST_PATH = '/server/audioflix-provider-host.html';
    const HOST_MARKER = 'eve-audioflix-provider-host';
    const HOST_PROBE_TIMEOUT_MS = 900;
    const PLAYER_READY_TIMEOUT_MS = 12000;
    let cachedHost = '';
    let cachedHostAt = 0;
    let hostProbe = null;

    const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

    function formatTime(value) {
        const seconds = Math.max(0, Number(value) || 0);
        const minutes = Math.floor(seconds / 60);
        return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    }

    function normalizeBase(value) {
        try {
            const url = new URL(String(value || ''));
            return /^https?:$/.test(url.protocol) ? url.origin : '';
        } catch { return ''; }
    }

    function providerHostCandidates() {
        const values = [
            window.EveAudioflixState?.ensure?.()?.nativeBridgeBase,
            /^https?:$/.test(location.protocol) ? location.origin : '',
            'http://127.0.0.1:8765',
            'http://127.0.0.1:8766',
            'http://127.0.0.1:8767',
            'http://127.0.0.1:8768',
            'http://127.0.0.1:8769',
            'http://127.0.0.1:8770',
            'http://127.0.0.1:3000'
        ];
        return [...new Set(values.map(normalizeBase).filter(Boolean))];
    }

    async function probeHost(base) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => controller?.abort(), HOST_PROBE_TIMEOUT_MS);
        try {
            const response = await fetch(`${base}${HOST_PATH}?probe=1`, {
                cache: 'no-store',
                signal: controller?.signal
            });
            if (!response.ok) return false;
            return (await response.text()).includes(HOST_MARKER);
        } catch { return false; }
        finally { clearTimeout(timer); }
    }

    async function findProviderHost(options = {}) {
        if (window.EveAudioflixNative?.isBridgeOffline?.()) return '';
        const force = options.force === true;
        if (!force && cachedHostAt && Date.now() - cachedHostAt < (cachedHost ? 60000 : 30000)) return cachedHost;
        if (hostProbe) return hostProbe;
        hostProbe = (async () => {
            for (const base of providerHostCandidates()) {
                if (await probeHost(base)) {
                    cachedHost = base;
                    cachedHostAt = Date.now();
                    return base;
                }
            }
            cachedHost = '';
            cachedHostAt = Date.now();
            return '';
        })();
        try { return await hostProbe; }
        finally { hostProbe = null; }
    }

    function createController(options = {}) {
        let stage = null;
        let currentItem = null;

        function ensureStage() {
            if (stage) return stage;
            stage = document.createElement('section');
            stage.className = 'audioflix-provider-stage';
            stage.hidden = true;
            stage.innerHTML = `
                <header>
                    <div><span>Internal player</span><strong></strong></div>
                    <div>
                        <button type="button" data-url-player-action="collapse">Minimize</button>
                        <a target="_blank" rel="noopener noreferrer">Open source</a>
                        <button type="button" data-url-player-action="stop">Close</button>
                    </div>
                </header>
                <p class="audioflix-provider-status"></p>
                <div class="audioflix-provider-frame"></div>
                <div class="audioflix-provider-queue" hidden>
                    <strong>Up next</strong>
                    <ol class="audioflix-provider-queue-list"></ol>
                </div>
                <footer class="audioflix-provider-transport">
                    <div class="audioflix-provider-buttons">
                        <button type="button" class="audioflix-provider-step" data-url-player-action="prev" hidden title="Previous track in the queue">⏮</button>
                        <button type="button" class="audioflix-provider-toggle" data-url-player-action="toggle">Play</button>
                        <button type="button" class="audioflix-provider-step" data-url-player-action="next" hidden title="Next track in the queue">⏭</button>
                    </div>
                    <div class="audioflix-provider-timeline">
                        <output class="audioflix-provider-time">0:00 / 0:00</output>
                        <input class="audioflix-provider-seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="Playback position">
                    </div>
                    <div class="audioflix-provider-options">
                        <label><span>Speed</span><select class="audioflix-provider-rate" aria-label="Playback speed">
                            ${[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${r}x</option>`).join('')}
                        </select></label>
                        <label class="audioflix-provider-volume-wrap"><span>Volume</span><input class="audioflix-provider-volume" type="range" min="0" max="1" step="0.01" value="1"></label>
                        <div class="audioflix-provider-tools">
                            <button type="button" data-url-player-action="restart" title="Restart this track from 0:00">↺ Restart</button>
                            <button type="button" data-url-player-action="repeat-one" aria-pressed="false" title="Repeat only this track when it ends">↻ Loop track</button>
                            <button type="button" data-url-player-action="details" title="Open Track Details for the current song">Track details</button>
                        </div>
                    </div>
                </footer>`;
            stage.addEventListener('click', (event) => {
                const button = event.target.closest('[data-url-player-action]');
                const action = button?.dataset.urlPlayerAction;
                if (action === 'stop') (options.onClose || options.onStop)?.();
                else if (action === 'toggle') options.onToggle?.();
                else if (action === 'prev') options.onStep?.(-1);
                else if (action === 'next') options.onStep?.(1);
                else if (action === 'queue-jump') options.onJump?.(Number(button.dataset.queueIndex || 0));
                else if (['restart', 'repeat-one', 'details'].includes(action)) window.EveAudioflix?.queueConnection?.action?.(action);
                else if (action === 'collapse') {
                    stage.classList.toggle('is-collapsed');
                    button.textContent = stage.classList.contains('is-collapsed') ? 'Expand' : 'Minimize';
                }
            });
            stage.addEventListener('change', (event) => {
                if (event.target.matches('.audioflix-provider-seek')) options.onSeek?.(Number(event.target.value || 0));
                else if (event.target.matches('.audioflix-provider-rate')) options.onRate?.(Number(event.target.value || 1));
            });
            stage.addEventListener('input', (event) => {
                if (event.target.matches('.audioflix-provider-seek')) {
                    const max = Number(event.target.max || 0) || 0, value = Number(event.target.value || 0) || 0;
                    event.target.style.setProperty('--progress', `${max > 0 ? (value / max) * 100 : 0}%`);
                } else if (event.target.matches('.audioflix-provider-volume')) {
                    const value = clamp(Number(event.target.value) || 0, 0, 1);
                    event.target.style.setProperty('--volume', `${value * 100}%`);
                    options.onVolume?.(value);
                }
            });
            document.body.appendChild(stage);
            return stage;
        }

        function open(item, provider, settings = {}) {
            const element = ensureStage();
            currentItem = item;
            const transportOnly = settings.visible === false;
            // Provider SDKs need a rendered iframe. Normal card playback keeps it mounted
            // off-screen unless this track explicitly opts into the compact provider panel.
            element.hidden = false;
            element.classList.toggle('is-transport-only', transportOnly);
            element.classList.toggle(
                'is-transport-hidden',
                transportOnly && item?.showProviderTransport !== true
            );
            element.classList.remove('has-error');
            element.classList.toggle('is-internal-view', settings.expanded === true);
            if (settings.expanded) element.classList.remove('is-collapsed');
            element.dataset.provider = String(provider || '').toLowerCase();
            element.querySelector('header span').textContent = 'Internal player';
            element.querySelector('header strong').textContent = item?.title || 'Linked audio';
            const source = element.querySelector('header a');
            source.href = item?.sourceUrl || item?.url || '#';
            source.textContent = provider === 'YouTube' ? 'Play on YouTube' : 'Open source';
            const volume = element.querySelector('.audioflix-provider-volume');
            const level = clamp(item?.volume ?? 1, 0, 1);
            volume.value = String(level);
            volume.style.setProperty('--volume', `${level * 100}%`);
            setStatus('Connecting inside EveOS...');
            return element.querySelector('.audioflix-provider-frame');
        }

        function setStatus(message, isError = false) {
            const element = ensureStage();
            element.classList.toggle('has-error', isError);
            element.querySelector('.audioflix-provider-status').textContent = String(message || '');
        }

        function setVisualVisible(visible) {
            ensureStage().classList.toggle('is-audio-only', visible === false);
        }

        // Queue mode: the stage follows a whole group instead of one locked-in track, so it lists
        // what is coming and exposes prev/next. Passing an empty list returns it to single-track
        // mode (queue block hidden, step buttons gone).
        function setQueue(entries, currentIndex) {
            const element = ensureStage();
            const list = Array.isArray(entries) ? entries : [];
            const box = element.querySelector('.audioflix-provider-queue');
            const steps = element.querySelectorAll('.audioflix-provider-step');
            box.hidden = list.length === 0;
            steps.forEach((button) => { button.hidden = list.length === 0; });
            const snapshot = window.EveAudioflix?.queueConnection?.snapshot?.() || {};
            const repeat = element.querySelector('[data-url-player-action="repeat-one"]');
            if (repeat) {
                repeat.setAttribute('aria-pressed', String(snapshot.repeatOne === true));
                repeat.textContent = snapshot.repeatOne === true ? '↻ Loop track on' : '↻ Loop track';
            }
            element.querySelector('.audioflix-provider-tools')?.toggleAttribute('hidden', list.length === 0);
            if (!list.length) return;
            const at = Number(currentIndex) || 0;
            element.querySelector('[data-url-player-action="prev"]').disabled = at <= 0;
            element.querySelector('[data-url-player-action="next"]').disabled = at >= list.length - 1;
            element.querySelector('.audioflix-provider-queue-list').innerHTML = list.map((entry, index) => {
                const title = String(entry?.title || 'Untitled');
                const safe = title.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
                const state = index === at ? ' class="is-current"' : '';
                return `<li${state}><button type="button" data-url-player-action="queue-jump" data-queue-index="${index}">${index === at ? '▶ ' : ''}${safe}</button></li>`;
            }).join('');
        }

        function setRate(rate) {
            const select = ensureStage().querySelector('.audioflix-provider-rate');
            if (select) select.value = String(Number(rate) || 1);
        }

        // Mirror a volume change made OUTSIDE this panel (the card slider) onto its own control.
        // The audio already followed via urlPlayback.setVolume; only the thumb stayed where it was,
        // so the two views showed different numbers for one track and the panel looked broken.
        function setVolume(value) {
            const input = ensureStage().querySelector('.audioflix-provider-volume');
            if (input) {
                const level = clamp(Number(value) || 0, 0, 1);
                input.value = String(level);
                input.style.setProperty('--volume', `${level * 100}%`);
            }
        }

        function setExpanded(expanded = true) {
            const element = ensureStage();
            element.hidden = false;
            element.classList.remove('is-transport-only', 'is-transport-hidden');
            element.classList.toggle('is-internal-view', expanded);
            if (expanded) element.classList.remove('is-collapsed');
        }

        function setTransportOnly(enabled = true) {
            const element = ensureStage();
            element.hidden = false;
            element.classList.toggle('is-transport-only', enabled === true);
            element.classList.toggle(
                'is-transport-hidden',
                enabled === true && currentItem?.showProviderTransport !== true
            );
            if (enabled) element.classList.remove('is-internal-view', 'is-collapsed');
        }

        function revealTransportFallback() {
            const element = ensureStage();
            element.hidden = false;
            element.classList.add('is-transport-only');
            element.classList.remove('is-transport-hidden', 'is-internal-view', 'is-collapsed');
            return element;
        }

        function sync(playback = {}) {
            if (!stage || stage.hidden) return;
            const current = Math.max(0, Number(playback.currentTime) || 0);
            const duration = Math.max(0, Number(playback.duration) || 0);
            const seek = stage.querySelector('.audioflix-provider-seek');
            seek.max = String(duration);
            seek.value = String(Math.min(current, duration || current));
            seek.style.setProperty('--progress', `${duration > 0 ? Math.min(100, (current / duration) * 100) : 0}%`);
            seek.disabled = duration <= 0;
            stage.querySelector('.audioflix-provider-time').textContent = `${formatTime(current)} / ${formatTime(duration)}`;
            stage.querySelector('[data-url-player-action="toggle"]').textContent = playback.paused === false ? 'Pause' : 'Play';
        }

        function hide() {
            if (!stage) return;
            stage.classList.remove('is-transport-only', 'is-transport-hidden');
            stage.hidden = true;
        }

        async function connectYouTubeBridge(item, videoId, callbacks = {}) {
            // Explicit Internal View retries should notice a server that started after an
            // earlier failed probe instead of honoring the 30-second negative cache.
            const base = await findProviderHost({ force: callbacks.expanded === true });
            if (!base) return null;
            const frameHost = open(item, 'YouTube', {
                expanded: callbacks.expanded === true,
                visible: callbacks.visible !== false
            });
            setVisualVisible(true);
            frameHost.replaceChildren();
            const token = `af-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            const hostOrigin = new URL(base).origin;
            const iframe = document.createElement('iframe');
            const params = new URLSearchParams({ provider: 'youtube', id: videoId, token, autoplay: '1', volume: String(clamp(item?.volume ?? 1, 0, 1)) });
            iframe.src = `${base}${HOST_PATH}?${params}`;
            iframe.title = `${item?.title || 'Audio'} - Internal player`;
            iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
            iframe.referrerPolicy = 'strict-origin-when-cross-origin';
            const bridgeState = { currentTime: 0, duration: 0, paused: true };
            let settled = false;
            let readyTimer = 0;

            const command = (action, value) => iframe.contentWindow?.postMessage({
                type: 'eve-audioflix-provider-command', token, action, value
            }, hostOrigin);
            const cleanup = () => {
                clearTimeout(readyTimer);
                window.removeEventListener('message', onMessage);
            };
            const player = {
                playVideo: () => command('play'),
                pauseVideo: () => command('pause'),
                seekTo: (value) => command('seek', Number(value) || 0),
                setVolume: (value) => command('volume', Number(value) || 0),
                getCurrentTime: () => bridgeState.currentTime,
                getDuration: () => bridgeState.duration,
                destroy() { command('stop'); cleanup(); iframe.remove(); }
            };

            function onMessage(event) {
                if (event.source !== iframe.contentWindow || event.origin !== hostOrigin) return;
                const detail = event.data;
                if (detail?.type !== 'eve-audioflix-provider' || detail.token !== token) return;
                if (detail.event === 'progress' || detail.event === 'ready') {
                    bridgeState.currentTime = Number(detail.currentTime) || 0;
                    bridgeState.duration = Number(detail.duration) || 0;
                    callbacks.onProgress?.({ ...bridgeState });
                }
                if (detail.event === 'state') {
                    bridgeState.paused = detail.state !== 'playing';
                    callbacks.onState?.(detail.state);
                }
                if (detail.event === 'ready' && !settled) {
                    settled = true;
                    clearTimeout(readyTimer);
                    callbacks.onReady?.({ ...bridgeState });
                    callbacks.resolve?.(player);
                }
                if (detail.event === 'error') {
                    const error = new Error(detail.message || 'The localhost YouTube player could not start.');
                    if (!settled) {
                        settled = true;
                        clearTimeout(readyTimer);
                        callbacks.reject?.(error);
                    } else callbacks.onError?.(error);
                }
            }

            return new Promise((resolve, reject) => {
                callbacks.resolve = resolve;
                callbacks.reject = reject;
                window.addEventListener('message', onMessage);
                readyTimer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    iframe.remove();
                    reject(new Error('The EveOS localhost player timed out while connecting.'));
                }, PLAYER_READY_TIMEOUT_MS);
                iframe.addEventListener('error', () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new Error('The EveOS localhost player could not be loaded.'));
                }, { once: true });
                frameHost.appendChild(iframe);
            });
        }

        return {
            open, hide, isOpen: () => !!stage && !stage.hidden && !stage.classList.contains('is-transport-only'),
            setStatus, setVisualVisible, setExpanded, setTransportOnly, revealTransportFallback,
            sync, connectYouTubeBridge,
            setQueue, setRate, setVolume,
            getFrame: () => ensureStage().querySelector('.audioflix-provider-frame'),
            getStage: () => stage,
            getItem: () => currentItem
        };
    }

    Object.assign(ns, { ready: true, createController, findProviderHost, providerHostCandidates });
})();
