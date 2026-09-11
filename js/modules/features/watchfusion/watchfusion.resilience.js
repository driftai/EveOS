(function () {
    'use strict';

    if (window.__eveWatchFusionResilienceReady) return;
    window.__eveWatchFusionResilienceReady = true;

    const PANELS = Object.freeze({
        overview: {
            label: 'Overview',
            title: 'WatchFusion workspace',
            body: 'Browse setup and feature areas without starting the WatchFusion runtime. Live media, rooms, and provider actions stay inactive until you explicitly press Start.'
        },
        nuvio: {
            label: 'Nuvio',
            title: 'Nuvio',
            body: 'Inspect whether Nuvio is installed and built while WatchFusion is stopped. Starting WatchFusion is only required when you actually want to open the live Nuvio surface.'
        },
        voxelvision: {
            label: 'VoxelVision',
            title: 'VoxelVision',
            body: 'VoxelVision source, YouTube helpers, and browser-model readiness can be reviewed before launch. Rendering and media conversion require the runtime.'
        },
        findMedia: {
            label: 'Find Media',
            title: 'Find Media',
            body: 'Provider discovery is a runtime feature. You can still review readiness here; start WatchFusion only when you are ready to resolve or play a source.'
        },
        watchParty: {
            label: 'WatchParty',
            title: 'WatchParty',
            body: 'Room controls and realtime synchronization stay dormant while the runtime is off. Nothing should open a terminal merely because you browsed this section.'
        }
    });

    const CONTROL_OFFLINE_TEXT = 'Local control is off. You can still browse WatchFusion and review its feature areas; live setup checks and runtime actions become available when you explicitly start local control.';
    const LIVE_WITHOUT_CONTROL_TEXT = 'WatchFusion is online. Live media stays available; local lifecycle/setup control can be enabled separately when you need it.';
    let latestStatus = null;
    let activePanel = 'overview';

    function ensureStyle() {
        if (document.querySelector('link[data-eve-watchfusion-resilience-style]')) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'css/modules/watchfusion-resilience.css?v=0d471f11203d';
        link.dataset.eveWatchfusionResilienceStyle = '1';
        document.head.appendChild(link);
    }

    function componentFor(panel) {
        const components = latestStatus?.components || {};
        if (panel === 'nuvio') return components.nuvio;
        if (panel === 'voxelvision') return components.voxelvision;
        if (panel === 'findMedia') return components.voxelYoutube;
        return null;
    }

    function readinessText(component) {
        if (!component) return 'Status not checked yet';
        if (component.ready === true) return 'Ready';
        if (component.ready === false) return 'Needs setup';
        return 'On demand';
    }

    function renderPanel(root) {
        const config = PANELS[activePanel] || PANELS.overview;
        const panel = root.querySelector('[data-wf-offline-panel]');
        if (!panel) return;
        const component = componentFor(activePanel);
        panel.replaceChildren();

        const heading = document.createElement('div');
        heading.className = 'watchfusion-offline-panel-head';
        const title = document.createElement('strong');
        title.textContent = config.title;
        const badge = document.createElement('span');
        badge.textContent = readinessText(component);
        heading.append(title, badge);

        const body = document.createElement('p');
        body.textContent = component?.message || config.body;
        panel.append(heading, body);

        if (activePanel !== 'overview') {
            const note = document.createElement('p');
            note.className = 'watchfusion-offline-runtime-note';
            note.textContent = 'Live actions are intentionally inactive while WatchFusion is stopped.';
            panel.append(note);
        }

        const actions = document.createElement('div');
        actions.className = 'watchfusion-offline-panel-actions';
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.className = 'secondary';
        refresh.dataset.wfAction = 'refresh';
        refresh.textContent = 'Refresh status';
        actions.append(refresh);

        if (activePanel !== 'overview') {
            const start = document.createElement('button');
            start.type = 'button';
            start.dataset.wfAction = 'start';
            start.textContent = 'Start WatchFusion';
            start.title = `${config.label} live actions become available after the WatchFusion runtime starts.`;
            actions.append(start);
        }
        panel.append(actions);
    }

    function setActive(root, key) {
        activePanel = PANELS[key] ? key : 'overview';
        root.querySelectorAll('[data-wf-offline-tab]').forEach((button) => {
            const selected = button.dataset.wfOfflineTab === activePanel;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        renderPanel(root);
    }

    function ensureNavigator() {
        const idle = document.querySelector('#watchfusion-overlay .watchfusion-idle');
        if (!idle || idle.querySelector('[data-wf-offline-nav]')) return;

        const root = document.createElement('section');
        root.className = 'watchfusion-offline-browser';
        root.dataset.wfOfflineNav = '1';

        const tabs = document.createElement('div');
        tabs.className = 'watchfusion-offline-tabs';
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', 'WatchFusion stopped-mode navigation');
        for (const [key, config] of Object.entries(PANELS)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary';
            button.dataset.wfOfflineTab = key;
            button.textContent = config.label;
            button.setAttribute('role', 'tab');
            button.addEventListener('click', () => setActive(root, key));
            tabs.append(button);
        }

        const panel = document.createElement('div');
        panel.className = 'watchfusion-offline-panel';
        panel.dataset.wfOfflinePanel = '1';
        root.append(tabs, panel);

        const components = idle.querySelector('[data-wf-components]');
        if (components) idle.insertBefore(root, components);
        else idle.append(root);
        setActive(root, activePanel);
    }

    function friendlyMessage(detail) {
        const message = String(detail?.message || '');
        const controlMissing = detail?.controllerAvailable === false
            || detail?.state === 'error'
            || detail?.state === 'degraded'
            || /failed to fetch|networkerror|load failed/i.test(message);
        if (detail?.running === true && controlMissing) return LIVE_WITHOUT_CONTROL_TEXT;
        if (controlMissing) return CONTROL_OFFLINE_TEXT;
        if (detail?.state === 'blocked') {
            const port = Number(detail?.port || 0);
            return port
                ? `Port ${port} is currently occupied by another process. EveOS service ports are registry-managed; stop the conflicting process or change the registered assignment, then refresh.`
                : 'The registered WatchFusion port is occupied by another process. Stop the conflicting process or change the registered assignment, then refresh.';
        }
        return message;
    }

    function normalizeVisibleMessage() {
        const message = document.querySelector('#watchfusion-overlay [data-wf-message]');
        if (!message) return;
        if (/failed to fetch|networkerror|load failed|eveos local control is unavailable/i.test(message.textContent || '')) {
            message.textContent = latestStatus?.running ? LIVE_WITHOUT_CONTROL_TEXT : CONTROL_OFFLINE_TEXT;
        }
    }

    function applyStatus(detail) {
        latestStatus = detail || null;
        ensureNavigator();
        const overlay = document.getElementById('watchfusion-overlay');
        if (!overlay) return;
        const message = overlay.querySelector('[data-wf-message]');
        const text = friendlyMessage(detail);
        if (message && text) message.textContent = text;
        const root = overlay.querySelector('[data-wf-offline-nav]');
        if (root) renderPanel(root);
        normalizeVisibleMessage();
    }

    window.addEventListener('eve:watchfusion-status', (event) => applyStatus(event.detail));

    const observer = new MutationObserver(() => {
        ensureNavigator();
        normalizeVisibleMessage();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    ensureStyle();
    ensureNavigator();
    normalizeVisibleMessage();
})();
