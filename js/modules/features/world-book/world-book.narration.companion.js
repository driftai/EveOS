window.EveWorldBookNarrationCompanion = window.EveWorldBookNarrationCompanion || {};

(function (ns) {
    'use strict';
    if (ns.ready) return;

    const POPUP_NAME = 'eveWorldBookReaderCompanion';
    const styles = `
        :host { color-scheme: dark; font-family: Georgia, "Times New Roman", serif; }
        * { box-sizing: border-box; }
        button, input { font: inherit; }
        .companion { width: 100%; min-width: 0; padding: 15px; border: 1px solid rgba(73,220,230,.34); border-radius: 16px; background: radial-gradient(circle at 85% 0, rgba(40,176,187,.17), transparent 35%), #061216; color: #e9fdff; box-shadow: 0 22px 70px rgba(0,0,0,.5); }
        .heading, .heading-actions, .controls, .timeline-labels, .route { display: flex; align-items: center; }
        .heading { justify-content: space-between; gap: 12px; }
        .heading span, .route span { color: #61e9f2; font: 700 .63rem/1.2 sans-serif; letter-spacing: .13em; text-transform: uppercase; }
        .heading-actions, .controls { gap: 7px; }
        h1 { margin: 4px 0 0; overflow: hidden; color: #f5ffff; font-size: 1.05rem; text-overflow: ellipsis; white-space: nowrap; }
        button { min-height: 34px; padding: 6px 10px; border: 1px solid rgba(95,222,231,.28); border-radius: 9px; background: rgba(12,42,48,.82); color: #dbfbfd; cursor: pointer; }
        button:hover { border-color: #68e9f1; background: rgba(21,79,87,.9); }
        button.primary { border-color: rgba(111,236,244,.62); background: linear-gradient(135deg, #238b95, #145f68); }
        button.icon { width: 34px; padding: 0; }
        .passage { display: -webkit-box; min-height: 60px; margin: 13px 0 10px; overflow: hidden; color: rgba(239,253,255,.8); font-size: .86rem; line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
        .timeline { width: 100%; accent-color: #65e8f0; }
        .timeline-labels { justify-content: space-between; gap: 8px; color: rgba(214,243,245,.58); font: .68rem/1.4 sans-serif; font-variant-numeric: tabular-nums; }
        .controls { justify-content: center; margin-top: 11px; }
        .route { justify-content: space-between; gap: 12px; margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(91,216,225,.15); color: rgba(218,244,246,.63); font: .69rem/1.4 sans-serif; }
        .route label { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
        .route input { width: 86px; accent-color: #65e8f0; }
        .companion.is-collapsed .passage, .companion.is-collapsed .timeline-wrap, .companion.is-collapsed .route { display: none; }
        .companion.is-collapsed .controls { margin-top: 10px; }
        @media (max-width: 380px) { .companion { padding: 11px; } .controls { gap: 4px; } button { padding-inline: 8px; } .route { align-items: flex-start; flex-direction: column; } }
    `;
    let latestState = null;
    let activeRoot = null;
    let activeHost = null;
    let activeWindow = null;
    let mode = '';

    const clamp = (value) => Math.min(1, Math.max(0, Number(value) || 0));
    const formatTime = (seconds) => {
        const safe = Math.max(0, Number(seconds) || 0);
        return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
    };
    const bridge = () => window.EveWorldBookNarrationBridge;

    function command(action, data = null) {
        return bridge()?.broadcastCommand?.(action, { data, queueIfUnavailable: false }) || 0;
    }

    function clearSurface(target = activeWindow) {
        if (target && target === activeWindow) activeWindow = null;
        if (activeHost?.isConnected) activeHost.remove();
        activeRoot = null;
        activeHost = null;
        mode = '';
    }

    function close() {
        const target = activeWindow;
        clearSurface(target);
        try { if (target && !target.closed) target.close(); } catch (_error) {}
    }

    function template() {
        return `<style>${styles}</style><main class="companion"><div class="heading"><div><span>World Book voice layer</span><h1 data-reader-title>No source selected</h1></div><div class="heading-actions"><button class="icon" type="button" data-reader-action="collapse" title="Collapse companion">-</button><button class="icon" type="button" data-reader-action="close" title="Close companion">&times;</button></div></div><p class="passage" data-reader-passage>Open Reader Library and choose something to hear.</p><div class="timeline-wrap"><input class="timeline" data-reader-progress type="range" min="0" max="1000" value="0" aria-label="Reader progress"><div class="timeline-labels"><span data-reader-clip>Ready</span><span data-reader-time>0:00 / 0:00</span></div></div><div class="controls"><button type="button" data-reader-action="previous" title="Previous clip">&#9664;</button><button class="primary" type="button" data-reader-action="play">Play</button><button type="button" data-reader-action="stop">Stop</button><button type="button" data-reader-action="next" title="Next clip">&#9654;</button><button type="button" data-reader-action="open-library">Library</button></div><div class="route"><div><span>Audioflix route</span><small data-reader-route>Local reader output</small></div><label>Volume <input data-reader-volume type="range" min="0" max="1" step="0.05" value="1"></label></div></main>`;
    }

    function bind(root) {
        root.querySelectorAll('[data-reader-action]').forEach(button => {
            button.addEventListener('click', () => {
                const action = button.dataset.readerAction;
                if (action === 'close') return close();
                if (action === 'collapse') {
                    const panel = root.querySelector('.companion');
                    panel?.classList.toggle('is-collapsed');
                    button.textContent = panel?.classList.contains('is-collapsed') ? '+' : '-';
                    return;
                }
                if (action === 'open-library') return bridge()?.openReader?.();
                if (action === 'play' && latestState?.status === 'playing') return command('pause');
                command(action);
            });
        });
        const progress = root.querySelector('[data-reader-progress]');
        progress?.addEventListener('change', event => {
            command('seek-progress', {
                value: Number(event.currentTarget.value) || 0,
                autoplay: latestState?.status === 'playing'
            });
        });
        root.querySelector('[data-reader-volume]')?.addEventListener('change', event => {
            bridge()?.saveSettings?.({ volume: Number(event.currentTarget.value) || 0 });
        });
    }

    function mount(host, targetWindow = null, nextMode = 'inline') {
        clearSurface();
        activeHost = host;
        activeWindow = targetWindow;
        mode = nextMode;
        activeRoot = host.shadowRoot || host.attachShadow({ mode: 'open' });
        activeRoot.innerHTML = template();
        bind(activeRoot);
        if (targetWindow) {
            targetWindow.addEventListener('pagehide', () => {
                if (activeWindow === targetWindow) clearSurface(targetWindow);
            }, { once: true });
        }
        update(latestState);
        return activeRoot;
    }

    function mountWindow(targetWindow, nextMode) {
        const doc = targetWindow.document;
        doc.title = 'EveOS Reader Companion';
        doc.documentElement.style.cssText = 'color-scheme:dark;background:#02090c;';
        doc.body.style.cssText = 'min-height:100vh;margin:0;padding:8px;box-sizing:border-box;background:#02090c;';
        doc.body.replaceChildren();
        const host = doc.createElement('div');
        doc.body.append(host);
        mount(host, targetWindow, nextMode);
        targetWindow.focus?.();
    }

    function mountInline() {
        let host = document.querySelector('[data-world-book-reader-companion]');
        if (!host) {
            host = document.createElement('div');
            host.dataset.worldBookReaderCompanion = '';
            Object.assign(host.style, {
                position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483000',
                width: 'min(450px, calc(100vw - 36px))'
            });
            document.body.append(host);
        }
        mount(host, null, 'inline');
    }

    async function open(seed = null) {
        if (seed) latestState = seed;
        if (activeRoot && (!activeWindow || !activeWindow.closed)) {
            activeWindow?.focus?.();
            return mode;
        }
        if (window.documentPictureInPicture?.requestWindow) {
            try {
                const pipWindow = await window.documentPictureInPicture.requestWindow({ width: 460, height: 300 });
                mountWindow(pipWindow, 'picture-in-picture');
                return mode;
            } catch (_error) {}
        }
        let popup = null;
        try {
            popup = window.open('', POPUP_NAME, 'popup=yes,width=470,height=330,resizable=yes,scrollbars=no');
        } catch (_error) {}
        if (popup) {
            mountWindow(popup, 'popup');
            return mode;
        }
        mountInline();
        return mode;
    }

    function update(nextState) {
        if (nextState && typeof nextState === 'object') latestState = nextState;
        if (!activeRoot) {
            syncAudioflixSummary();
            return;
        }
        const state = latestState || {};
        const ratio = clamp(state.overallRatio);
        const passageRatio = clamp(state.passageRatio);
        const duration = Math.max(0, Number(state.passageDuration) || 0);
        const title = state.source?.title || 'No source selected';
        const status = String(state.status || 'idle');
        activeRoot.querySelector('[data-reader-title]').textContent = title;
        activeRoot.querySelector('[data-reader-passage]').textContent = state.passage || 'Open Reader Library and choose something to hear.';
        activeRoot.querySelector('[data-reader-progress]').value = Math.round(ratio * 1000);
        activeRoot.querySelector('[data-reader-clip]').textContent = state.passageCount
            ? `Clip ${Number(state.index || 0) + 1} of ${state.passageCount} / ${status}` : 'Ready';
        activeRoot.querySelector('[data-reader-time]').textContent = `${formatTime(duration * passageRatio)} / ${formatTime(duration)}`;
        const play = activeRoot.querySelector('[data-reader-action="play"]');
        play.textContent = status === 'playing' ? 'Pause' : status === 'paused' ? 'Resume' : 'Play';
        const settings = bridge()?.settings?.() || {};
        activeRoot.querySelector('[data-reader-route]').textContent = state.output === 'native-default'
            ? 'World Book -> Windows default output'
            : settings.routeToAudioflix ? 'World Book -> Audioflix native output' : 'World Book -> browser output';
        activeRoot.querySelector('[data-reader-volume]').value = Number(settings.volume ?? 1);
        syncAudioflixSummary();
    }

    function renderAudioflixSummary() {
        const state = latestState || bridge()?.getState?.();
        return `<section class="audioflix-reader-route-card" data-audioflix-reader-summary${state?.source ? '' : ' hidden'}><div><span>World Book Reader</span><strong data-reader-summary-title></strong><small data-reader-summary-state></small></div><button type="button" data-af-action="open-reader-companion">Detach controls</button></section>`;
    }

    function syncAudioflixSummary() {
        const state = latestState || bridge()?.getState?.();
        document.querySelectorAll?.('[data-audioflix-reader-summary]')?.forEach(host => {
            host.hidden = !state?.source;
            host.querySelector('[data-reader-summary-title]').textContent = state?.source?.title || 'No reader source';
            host.querySelector('[data-reader-summary-state]').textContent = state?.passageCount
                ? `Clip ${Number(state.index || 0) + 1} of ${state.passageCount} / ${state.status || 'ready'}`
                : 'Open Reader Library to choose a source';
        });
    }

    window.addEventListener('beforeunload', close, { once: true });
    Object.assign(ns, {
        ready: true,
        open,
        close,
        update,
        renderAudioflixSummary,
        syncAudioflixSummary,
        getMode: () => mode,
        getState: () => latestState
    });
})(window.EveWorldBookNarrationCompanion);
