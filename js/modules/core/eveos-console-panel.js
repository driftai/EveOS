/**
 * eveos-console-panel.js
 *
 * The Local Services section of Settings: which EveOS servers are up, on which ports, whether each
 * shows its terminal window, and whether a successful individual tool Stop also closes Local Control.
 *
 * Keep the controls visible even when Local Control is offline. In that state the panel renders the
 * last-known preferences (or safe defaults on a fresh page), marks live status unavailable, disables
 * mutations, and offers the same localhost startup path used by Search Monitor.
 */
(function () {
    'use strict';

    if (window.EveOSConsolePanel) return;

    const CONSOLES_PATH = '/api/control-plane/consoles';
    const PANEL_SELECTOR = '#eveosConsolePanel, [data-eveos-console-panel]';
    const OFFLINE_SERVICE_SPECS = [
        ['web', 'EveOS localhost', [['EVEOS_WEB_PORT', 8765]]],
        ['gemini', 'Gemini backend', [['GEMINI_WS_PORT', 9085], ['GEMINI_STATUS_PORT', 9086]]],
        ['worldBook', 'World Book', [['WORLD_BOOK_PORT', 8766]]],
        ['piano', 'Piano Auto Player', [['PIANO_PLAYER_PORT', 8771]]],
        ['watchFusion', 'WatchFusion', [['WATCHFUSION_PORT', 9087]]]
    ];
    let lastPayload = null;
    let livePreviewOpen = false;
    let startupBusy = false;
    let startupMessage = '';

    function control() {
        return window.EveOSLocalControl || null;
    }

    function panel() {
        return document.querySelector(PANEL_SELECTOR);
    }

    function registryPort(name, fallback) {
        return Number(window.EveOSPortRegistry?.get?.(name, fallback)) || Number(fallback) || 0;
    }

    // The overview sweeps netstat and probes three services, which measured ~1.8s on a warm plane.
    // A tighter budget aborted the request outright and reported a running plane as absent.
    async function request(options, timeoutMs) {
        const plane = control();
        if (!plane) return null;
        try {
            const result = await plane.fetchJson(plane.baseUrl() + CONSOLES_PATH, options, timeoutMs || 8000);
            // fetchJson shapes vary across callers; accept either the payload or a {payload} wrapper.
            const payload = result?.services ? result : result?.payload;
            return payload?.services ? payload : null;
        } catch (error) {
            return null;
        }
    }

    function note(text, extraStyle) {
        const element = document.createElement('div');
        element.style.cssText = 'font-size:0.76rem; opacity:0.7; margin-top:6px;' + (extraStyle || '');
        element.textContent = text;
        return element;
    }

    function statusDot(running) {
        const dot = document.createElement('span');
        dot.setAttribute('aria-hidden', 'true');
        dot.style.cssText = 'width:8px; height:8px; border-radius:50%; flex:0 0 auto; background:'
            + (running ? 'var(--accent, #4ade80)' : 'rgba(148,163,184,0.55)');
        return dot;
    }

    function toggle(checked, disabled, onChange) {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:0.78rem;'
            + (disabled ? ' opacity:0.55; cursor:not-allowed;' : ' cursor:pointer;');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!checked;
        input.disabled = !!disabled;
        input.addEventListener('change', () => onChange(input.checked));
        const text = document.createElement('span');
        text.textContent = 'Headless';
        label.append(input, text);
        return label;
    }

    function disconnectedPayload() {
        const previousByKey = new Map((lastPayload?.services || []).map((service) => [service.key, service]));
        return {
            ok: false,
            disconnected: true,
            default: lastPayload?.default === true,
            envForced: lastPayload?.envForced === true,
            keepLocalControlAfterToolStop: lastPayload
                ? lastPayload.keepLocalControlAfterToolStop === true
                : false,
            controlPlanePort: registryPort('GEMINI_CONTROL_PORT', 9082),
            services: OFFLINE_SERVICE_SPECS.map(([key, label, portSpecs]) => {
                const previous = previousByKey.get(key) || {};
                return {
                    key,
                    label,
                    running: false,
                    available: false,
                    ports: previous.ports?.length
                        ? previous.ports
                        : portSpecs.map(([name, fallback]) => registryPort(name, fallback)),
                    message: 'Local Control offline',
                    headless: previous.headless === true,
                    overridden: previous.overridden === true
                };
            })
        };
    }

    /** Fold a preferences-only reply into the rows already on screen. */
    function mergePreferences(payload, reply) {
        if (!payload) return reply;
        const byKey = new Map((reply.services || []).map((service) => [service.key, service]));
        return {
            ...payload,
            default: reply.default,
            envForced: reply.envForced,
            keepLocalControlAfterToolStop: reply.keepLocalControlAfterToolStop === true,
            services: (payload.services || []).map((service) => ({
                ...service,
                ...(byKey.get(service.key) || {})
            }))
        };
    }

    async function setConsole(service, headless) {
        const reply = await request({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service, headless: !!headless })
        }, 4000);
        if (reply) {
            // The reply deliberately carries no running/ports: a console switch starts nothing, so
            // re-probing costs ~2s to confirm what cannot have changed. Keep the state we have and
            // take only the preferences, or the rows would blank out on every toggle.
            lastPayload = reply.preferencesOnly ? mergePreferences(lastPayload, reply) : reply;
            render(lastPayload);
            return;
        }
        render(disconnectedPayload(), true);
    }

    async function setCloseLocalControlAfterToolStop(closeAfterStop) {
        const reply = await request({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keepLocalControlAfterToolStop: !closeAfterStop })
        }, 4000);
        if (reply) {
            lastPayload = reply.preferencesOnly ? mergePreferences(lastPayload, reply) : reply;
            render(lastPayload);
            return;
        }
        render(disconnectedPayload(), true);
    }

    async function startLocalServices() {
        startupBusy = true;
        startupMessage = 'Starting localhost and Local Control...';
        render(disconnectedPayload(), true);
        try {
            let state = null;
            if (window.EveOSControlPlane?.start) {
                state = await window.EveOSControlPlane.start();
            } else if (control()?.ensure) {
                state = await control().ensure({ timeoutMs: 45000 });
            } else {
                throw new Error('The EveOS local startup bridge is not loaded yet.');
            }

            const payload = await request();
            if (payload) {
                lastPayload = payload;
                startupBusy = false;
                startupMessage = '';
                render(lastPayload);
                return payload;
            }
            startupMessage = state?.message || 'Local Control did not become reachable yet.';
        } catch (error) {
            startupMessage = error?.message || 'Local Control did not start.';
        }
        startupBusy = false;
        render(disconnectedPayload(), true);
        return null;
    }

    function disconnectedNotice() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'padding:10px; margin-bottom:10px; border:1px solid rgba(148,163,184,0.28);'
            + ' border-radius:8px; background:rgba(148,163,184,0.07);';

        const title = document.createElement('div');
        title.style.cssText = 'font-size:0.84rem; font-weight:600; margin-bottom:4px;';
        title.textContent = 'Local Services controls are offline';
        const copy = note(
            'Start EveOS localhost from Search Monitor, or use the button below. These settings stay visible '
            + 'but read-only until Local Control on port 9082 connects.',
            ' margin-top:0; opacity:0.78;'
        );
        wrap.append(title, copy);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-panel-link';
        button.style.cssText = 'font-size:0.78rem; padding:6px 10px; margin-top:8px;';
        button.textContent = startupBusy ? 'Starting...' : 'Start localhost & Local Services';
        button.disabled = startupBusy;
        button.addEventListener('click', () => startLocalServices());
        wrap.appendChild(button);

        if (startupMessage) wrap.appendChild(note(startupMessage));
        wrap.appendChild(note('Manual fallback: tools\\batch\\start-eveos-control.bat.'));
        return wrap;
    }

    function lifecyclePreference(payload, disabled) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:flex-start; gap:10px; padding:9px;'
            + ' border:1px solid rgba(148,163,184,0.22); border-radius:8px; margin-bottom:10px;'
            + (disabled ? ' opacity:0.55;' : '');

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = payload.keepLocalControlAfterToolStop !== true;
        input.disabled = !!disabled;
        input.setAttribute('aria-label', 'Close Local Control after individual tool Stop');
        if (!disabled) input.addEventListener('change', () => setCloseLocalControlAfterToolStop(input.checked));

        const copy = document.createElement('label');
        copy.style.cssText = 'display:flex; flex-direction:column; gap:3px;'
            + (disabled ? ' cursor:not-allowed;' : ' cursor:pointer;');
        const title = document.createElement('span');
        title.style.cssText = 'font-size:0.82rem;';
        title.textContent = 'Close Local Control after individual tool Stop';
        const description = document.createElement('span');
        description.style.cssText = 'font-size:0.74rem; opacity:0.72; line-height:1.35;';
        description.textContent = 'On by default: individual tool Stop exits 9082 after replying; failed stops keep it alive. '
            + 'Uncheck to keep port 9082 ready for other tools. Global Stop always exits it.';
        copy.append(title, description);
        if (!disabled) {
            copy.addEventListener('click', () => {
                input.checked = !input.checked;
                setCloseLocalControlAfterToolStop(input.checked);
            });
        }

        row.append(input, copy);
        return row;
    }

    function serviceRow(service, envForced, disconnected) {
        const unavailable = disconnected || service.available === false;
        const row = document.createElement('div');
        row.setAttribute('data-console-service', service.key);
        row.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;'
            + ' padding:7px 9px; border:1px solid rgba(148,163,184,0.22); border-radius:8px;'
            + ' margin-bottom:6px;' + (unavailable ? ' opacity:0.55;' : '');

        const name = document.createElement('span');
        name.style.cssText = 'font-size:0.84rem; min-width:130px;';
        name.textContent = service.label || service.key;

        const state = document.createElement('span');
        state.style.cssText = 'font-size:0.76rem; opacity:0.8;';
        state.textContent = unavailable ? 'unavailable' : (service.running ? 'running' : 'stopped');

        const ports = document.createElement('code');
        ports.style.cssText = 'font-size:0.74rem; opacity:0.85; margin-left:auto;';
        ports.textContent = service.ports?.length ? service.ports.join(', ') : 'no port';

        row.append(statusDot(!unavailable && service.running), name, state, ports);
        row.appendChild(toggle(service.headless, envForced || unavailable,
            (checked) => setConsole(service.key, checked)));
        if (service.overridden && !envForced) {
            const badge = document.createElement('span');
            badge.style.cssText = 'font-size:0.68rem; opacity:0.7;';
            badge.textContent = '(overrides default)';
            row.appendChild(badge);
        }
        return row;
    }

    function livePreview(payload, disconnected) {
        const web = (payload.services || []).find((service) => service.key === 'web');
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top:10px;';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-panel-link';
        button.style.cssText = 'font-size:0.78rem; padding:5px 10px;';
        button.textContent = livePreviewOpen ? 'Hide live view' : 'Show live view';
        // Pointing a frame at a dead port renders a browser error page, which reads like EveOS is
        // broken rather than simply not started. Offer the view only when there is something there.
        button.disabled = disconnected || !web?.running;
        button.addEventListener('click', () => {
            livePreviewOpen = !livePreviewOpen;
            render(lastPayload);
        });
        wrap.appendChild(button);

        if (disconnected) {
            wrap.appendChild(note('Live view is unavailable until Local Control reconnects.'));
            return wrap;
        }
        if (!web?.running) {
            wrap.appendChild(note('Start EveOS localhost to preview the live server here.'));
            return wrap;
        }
        if (!livePreviewOpen) return wrap;

        const frame = document.createElement('iframe');
        frame.src = `http://127.0.0.1:${web.ports[0]}/EveOS.html`;
        frame.title = 'EveOS localhost live view';
        frame.loading = 'lazy';
        frame.style.cssText = 'width:100%; height:220px; margin-top:8px; border:1px solid'
            + ' rgba(148,163,184,0.25); border-radius:8px; background:rgba(0,0,0,0.2);';
        wrap.appendChild(frame);
        wrap.appendChild(note(`Serving ${frame.src}`));
        return wrap;
    }

    function render(payload, disconnected) {
        const host = panel();
        if (!host) return;
        host.textContent = '';
        if (!payload) payload = disconnectedPayload();
        const offline = disconnected === true || payload.disconnected === true;

        if (offline) host.appendChild(disconnectedNotice());
        host.appendChild(lifecyclePreference(payload, offline));

        const envForced = payload.envForced === true;
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:8px;'
            + (offline ? ' opacity:0.55;' : '');
        const heading = document.createElement('span');
        heading.style.cssText = 'font-size:0.82rem;';
        heading.textContent = 'Default for new services';
        header.appendChild(heading);
        header.appendChild(toggle(payload.default, envForced || offline,
            (checked) => setConsole('default', checked)));
        host.appendChild(header);

        (payload.services || []).forEach((service) => host.appendChild(serviceRow(service, envForced, offline)));

        if (offline) {
            host.appendChild(note('Saved values load when Local Control reconnects. Controls are disabled while offline.'));
        } else if (envForced) {
            host.appendChild(note('EVEOS_HEADLESS is set in the environment and overrides every console switch'
                + ' here. Unset it to control consoles from this panel.'));
        } else {
            host.appendChild(note('A console preference applies the next time that service starts.'
                + ' Already-running servers keep the window they were started with.'));
        }
        host.appendChild(livePreview(payload, offline));
        if (offline) {
            host.appendChild(note(`Control plane offline on port ${payload.controlPlanePort || 9082}.`));
        } else if (payload.controlPlanePort) {
            host.appendChild(note(`Control plane on port ${payload.controlPlanePort}.`));
        }
    }

    async function refresh() {
        const host = panel();
        if (!host) return null;
        host.textContent = '';
        host.appendChild(note('Checking local services...'));
        let payload = await request();
        if (!payload) payload = await request();
        if (payload) {
            lastPayload = payload;
            startupBusy = false;
            startupMessage = '';
            render(lastPayload);
            return lastPayload;
        }
        render(disconnectedPayload(), true);
        return null;
    }

    window.EveOSConsolePanel = Object.freeze({
        refresh,
        render,
        setConsole,
        setCloseLocalControlAfterToolStop,
        startLocalServices,
        getLastPayload: () => lastPayload
    });
})();
