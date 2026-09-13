/**
 * eveos-console-panel.js
 *
 * The Local Services section of Settings: which EveOS servers are up, on which ports, whether each
 * shows its terminal window, and whether a successful individual tool Stop also closes Local Control.
 *
 * Consoles are headed by default now, so "what is actually running?" should be answerable by
 * looking. But the windows only tell you a process exists -- not which port it took, not that a
 * service you thought was off is quietly up. This panel is the one place that answers both, and the
 * only place to change these local-service preferences without editing a JSON file by hand.
 *
 * Everything comes from a single GET so the list cannot render half-stale. Console preferences apply
 * at the next start of that service; the Local Control lifetime preference applies immediately.
 */
(function () {
    'use strict';

    if (window.EveOSConsolePanel) return;

    const CONSOLES_PATH = '/api/control-plane/consoles';
    const PANEL_SELECTOR = '#eveosConsolePanel, [data-eveos-console-panel]';
    let lastPayload = null;
    let livePreviewOpen = false;

    function control() {
        return window.EveOSLocalControl || null;
    }

    function panel() {
        return document.querySelector(PANEL_SELECTOR);
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
        }
        // A failed write re-renders from stored state, so the switch cannot show an unsaved value.
        render(lastPayload);
    }

    async function setCloseLocalControlAfterToolStop(closeAfterStop) {
        const reply = await request({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keepLocalControlAfterToolStop: !closeAfterStop })
        }, 4000);
        if (reply) {
            lastPayload = reply.preferencesOnly ? mergePreferences(lastPayload, reply) : reply;
        }
        render(lastPayload);
    }

    function lifecyclePreference(payload) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:flex-start; gap:10px; padding:9px;'
            + ' border:1px solid rgba(148,163,184,0.22); border-radius:8px; margin-bottom:10px;';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = payload.keepLocalControlAfterToolStop !== true;
        input.setAttribute('aria-label', 'Close Local Control after individual tool Stop');
        input.addEventListener('change', () => setCloseLocalControlAfterToolStop(input.checked));

        const copy = document.createElement('label');
        copy.style.cssText = 'display:flex; flex-direction:column; gap:3px; cursor:pointer;';
        const title = document.createElement('span');
        title.style.cssText = 'font-size:0.82rem;';
        title.textContent = 'Close Local Control after individual tool Stop';
        const description = document.createElement('span');
        description.style.cssText = 'font-size:0.74rem; opacity:0.72; line-height:1.35;';
        description.textContent = 'Off by default: individual tool Stop keeps port 9082 ready. When enabled, '
            + 'a successful tool Stop exits 9082 after replying; failed stops keep it alive. Global Stop always exits it.';
        copy.append(title, description);
        copy.addEventListener('click', () => {
            input.checked = !input.checked;
            setCloseLocalControlAfterToolStop(input.checked);
        });

        row.append(input, copy);
        return row;
    }

    function serviceRow(service, envForced) {
        const row = document.createElement('div');
        row.setAttribute('data-console-service', service.key);
        row.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;'
            + ' padding:7px 9px; border:1px solid rgba(148,163,184,0.22); border-radius:8px;'
            + ' margin-bottom:6px;';

        const name = document.createElement('span');
        name.style.cssText = 'font-size:0.84rem; min-width:130px;';
        name.textContent = service.label || service.key;

        const state = document.createElement('span');
        state.style.cssText = 'font-size:0.76rem; opacity:0.8;';
        state.textContent = service.running ? 'running' : 'stopped';

        const ports = document.createElement('code');
        ports.style.cssText = 'font-size:0.74rem; opacity:0.85; margin-left:auto;';
        ports.textContent = service.ports?.length ? service.ports.join(', ') : 'no port';

        row.append(statusDot(service.running), name, state, ports);
        row.appendChild(toggle(service.headless, envForced, (checked) => setConsole(service.key, checked)));
        if (service.overridden && !envForced) {
            const badge = document.createElement('span');
            badge.style.cssText = 'font-size:0.68rem; opacity:0.7;';
            badge.textContent = '(overrides default)';
            row.appendChild(badge);
        }
        return row;
    }

    function livePreview(payload) {
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
        button.disabled = !web?.running;
        button.addEventListener('click', () => {
            livePreviewOpen = !livePreviewOpen;
            render(lastPayload);
        });
        wrap.appendChild(button);

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

    function render(payload) {
        const host = panel();
        if (!host) return;
        host.textContent = '';
        if (!payload) {
            host.appendChild(note('Local control plane not reached. Start it from the site header, or'
                + ' run tools\\batch\\start-eveos-control.bat.', ' opacity:0.75;'));
            return;
        }

        host.appendChild(lifecyclePreference(payload));

        const envForced = payload.envForced === true;
        const header = document.createElement('div');
        header.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:8px;';
        const heading = document.createElement('span');
        heading.style.cssText = 'font-size:0.82rem;';
        heading.textContent = 'Default for new services';
        header.appendChild(heading);
        header.appendChild(toggle(payload.default, envForced, (checked) => setConsole('default', checked)));
        host.appendChild(header);

        (payload.services || []).forEach((service) => host.appendChild(serviceRow(service, envForced)));

        if (envForced) {
            host.appendChild(note('EVEOS_HEADLESS is set in the environment and overrides every console switch'
                + ' here. Unset it to control consoles from this panel.'));
        } else {
            host.appendChild(note('A console preference applies the next time that service starts.'
                + ' Already-running servers keep the window they were started with.'));
        }
        host.appendChild(livePreview(payload));
        if (payload.controlPlanePort) {
            host.appendChild(note(`Control plane on port ${payload.controlPlanePort}.`));
        }
    }

    async function refresh() {
        const host = panel();
        if (!host) return null;
        // Claim the section immediately. Observed once against a plane that had only just come up:
        // the request timed out, nothing replaced the template's placeholder, and the section sat
        // there reading as though it had rendered -- the most misleading state this panel can show.
        host.textContent = '';
        host.appendChild(note('Checking local services...'));
        lastPayload = await request();
        if (!lastPayload) lastPayload = await request();
        render(lastPayload);
        return lastPayload;
    }

    window.EveOSConsolePanel = Object.freeze({
        refresh,
        render,
        setConsole,
        setCloseLocalControlAfterToolStop,
        getLastPayload: () => lastPayload
    });
})();
