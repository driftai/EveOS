window.EveAudioflixPiano = window.EveAudioflixPiano || {};

(function (ns) {
    'use strict';
    if (ns.ready) return;

    const state = {
        baseUrl: '', controllerAvailable: false, directAvailable: false,
        installed: true, running: false, desiredRunning: false,
        setupAvailable: false, youtubeSetup: false, hifiSetup: false,
        phase: 'checking', busy: false, port: 8771,
        url: 'http://127.0.0.1:8771/', localUrl: 'http://127.0.0.1:8771/',
        publicUrl: '', exposureMode: 'local', appVersion: '',
        message: 'Checking Piano Auto Player...'
    };
    let launchPollTimer = 0;
    let launchPollDeadline = 0;

    function serviceUrl() {
        const port = Number(window.config?.bridges?.pianoPlayerPort) || 8771;
        return `http://127.0.0.1:${port}/`;
    }

    function controllerBases() {
        const helper = window.EveOSLocalControl?.baseUrl?.();
        const port = Number(window.config?.bridges?.localControlPort
            || window.config?.bridges?.geminiControlPort) || 9082;
        const values = [helper || `http://127.0.0.1:${port}`];
        if (/^https?:$/.test(location.protocol) && /^(127\.0\.0\.1|localhost)$/i.test(location.hostname)) {
            values.push(location.origin);
        }
        values.push('http://127.0.0.1:8765', 'http://127.0.0.1:3000');
        return [...new Set(values.filter(Boolean))];
    }

    async function json(url, options, timeoutMs = 1800) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message || `Request failed (${response.status})`);
            return payload;
        } finally {
            clearTimeout(timer);
        }
    }

    function publish() {
        window.dispatchEvent(new CustomEvent('eve:audioflix-piano-status', { detail: { ...state } }));
    }

    function apply(payload, baseUrl) {
        state.baseUrl = baseUrl || state.baseUrl;
        state.controllerAvailable = true;
        state.installed = payload.installed !== false;
        state.running = payload.running === true;
        state.directAvailable = state.running;
        state.desiredRunning = payload.desiredRunning === true;
        state.phase = String(payload.state || (state.running ? 'running' : 'stopped'));
        state.port = Number(payload.port) || state.port;
        state.localUrl = String(payload.localUrl || serviceUrl());
        state.publicUrl = String(payload.publicUrl || '');
        state.exposureMode = String(payload.exposureMode || 'local');
        state.url = String(payload.url || state.publicUrl || state.localUrl || serviceUrl());
        state.appVersion = String(payload.appVersion || state.appVersion || '');
        state.setupAvailable = payload.setupAvailable === true;
        state.youtubeSetup = payload.youtubeSetup === true;
        state.hifiSetup = payload.hifiSetup === true;
        state.message = String(payload.message || '');
    }

    async function findController() {
        for (const baseUrl of controllerBases()) {
            try {
                const payload = await json(`${baseUrl}/api/piano-player/status`, null, 2600);
                return { baseUrl, payload };
            } catch (_) {}
        }
        return null;
    }

    async function directStatus() {
        try {
            const payload = await json(`${serviceUrl()}api/status`, null, 1200);
            return payload.ok === true && payload.service === 'piano-auto-player'
                && payload.appVersion ? payload : null;
        } catch (_) {
            return null;
        }
    }

    async function sharedExposure() {
        if (!/^https?:$/.test(location.protocol)) return null;
        try {
            const payload = await json(`${location.origin}/api/status`, null, 2200);
            if (payload?.service !== 'eveos-local-server') return null;
            const exposure = payload?.exposures?.piano;
            if (!exposure?.active || !exposure.publicUrl) return null;
            return exposure;
        } catch (_) {
            return null;
        }
    }

    async function refresh() {
        const [managed, direct, exposure] = await Promise.all([findController(), directStatus(), sharedExposure()]);
        if (managed) {
            apply(managed.payload, managed.baseUrl);
            if (direct) {
                state.running = state.directAvailable = true;
                state.phase = 'running';
                state.appVersion = String(direct.appVersion);
                // The host can always see localhost, even while a remote Audioflix client
                // needs the selected public URL. Never let that local health result erase
                // controller exposure metadata.
                if (state.exposureMode === 'local' || !state.publicUrl) state.url = serviceUrl();
                state.message = state.exposureMode === 'local'
                    ? 'Piano Auto Player is online locally.'
                    : `Piano Auto Player is online through ${state.exposureMode}.`;
            }
        } else if (exposure) {
            Object.assign(state, {
                baseUrl: '', controllerAvailable: false, directAvailable: false,
                installed: true, running: true, phase: 'shared',
                publicUrl: String(exposure.publicUrl), exposureMode: String(exposure.mode || 'cloudflare'),
                url: String(exposure.publicUrl), localUrl: serviceUrl(),
                message: `Piano Auto Player is selectively shared through ${exposure.mode || 'Cloudflare'}.`
            });
        } else if (direct) {
            Object.assign(state, {
                baseUrl: '', controllerAvailable: false, directAvailable: true,
                installed: true, running: true, phase: 'running', url: serviceUrl(),
                localUrl: serviceUrl(), publicUrl: '', exposureMode: 'local',
                appVersion: String(direct.appVersion),
                message: 'Piano Auto Player is online through a standalone localhost launcher.'
            });
        } else {
            Object.assign(state, {
                baseUrl: '', controllerAvailable: false, directAvailable: false,
                running: false, phase: 'unavailable', url: serviceUrl(), localUrl: serviceUrl(),
                publicUrl: '', exposureMode: 'local',
                message: /^https?:$/.test(location.protocol) && !/^(127\.0\.0\.1|localhost)$/i.test(location.hostname)
                    ? 'Piano is not selectively shared. Start it from the host PC and choose LAN or Cloudflare Router.'
                    : 'Piano Auto Player is stopped.'
            });
        }
        publish();
        return { ...state };
    }

    async function ensureController() {
        const found = await findController();
        if (found) return found;
        if (!window.EveOSLocalControl?.ensure) {
            throw new Error('EveOS local control is unavailable. Reload EveOS on the host PC and try again.');
        }
        state.phase = 'enabling';
        state.message = 'Starting EveOS local control for Piano...';
        publish();
        const control = await window.EveOSLocalControl.ensure();
        const baseUrl = control.baseUrl || window.EveOSLocalControl.baseUrl();
        return { baseUrl, payload: await json(`${baseUrl}/api/piano-player/status`, null, 3500) };
    }

    function stopLaunchPolling() {
        if (launchPollTimer) clearTimeout(launchPollTimer);
        launchPollTimer = 0;
    }

    async function pollLaunch() {
        stopLaunchPolling();
        if (Date.now() >= launchPollDeadline) {
            state.phase = 'stopped';
            state.message = 'No Piano runtime was detected yet. Press Start when you are ready to choose a mode.';
            publish();
            return;
        }
        const managed = await findController();
        if (managed) {
            apply(managed.payload, managed.baseUrl);
            if (state.running) {
                publish();
                return;
            }
        }
        state.phase = 'selecting';
        state.message = 'Choose Piano exposure mode in the opened terminal.';
        publish();
        launchPollTimer = setTimeout(pollLaunch, 900);
    }

    async function setRunning(enabled) {
        if (state.busy) return { ...state };
        state.busy = true;
        state.phase = enabled ? 'selecting' : 'stopping';
        state.message = enabled ? 'Opening Piano selective boot...' : 'Stopping Piano Auto Player...';
        publish();
        try {
            const managed = await ensureController();
            const payload = await json(
                `${managed.baseUrl}/api/piano-player/${enabled ? 'launch' : 'stop'}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
                10000
            );
            apply(payload, managed.baseUrl);
            if (enabled && payload.launchPrompt) {
                state.phase = 'selecting';
                state.message = payload.message || 'Choose Localhost, LAN, or Cloudflare Router in the Piano terminal.';
                launchPollDeadline = Date.now() + 90_000;
                void pollLaunch();
            } else if (!enabled) {
                stopLaunchPolling();
            }
            publish();
            return { ...state };
        } catch (error) {
            state.phase = 'error';
            state.message = error?.message || 'Piano lifecycle request failed.';
            publish();
            return { ...state };
        } finally {
            state.busy = false;
            publish();
        }
    }

    async function openSetup() {
        if (state.busy) return { ...state };
        state.busy = true;
        state.message = 'Opening Piano setup...';
        publish();
        try {
            const managed = await ensureController();
            const payload = await json(
                `${managed.baseUrl}/api/piano-player/setup`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
                8000
            );
            apply(payload, managed.baseUrl);
            return { ...state };
        } catch (error) {
            state.phase = 'error';
            state.message = error?.message || 'Piano setup could not be opened.';
            return { ...state };
        } finally {
            state.busy = false;
            publish();
        }
    }

    Object.assign(ns, {
        ready: true, state, serviceUrl, refresh,
        start: () => setRunning(true), stop: () => setRunning(false), setup: openSetup
    });
})(window.EveAudioflixPiano);