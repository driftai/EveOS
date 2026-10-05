(function () {
    'use strict';

    if (window.GeminiShutdownUI) return;

    const BUTTON_ID = 'gemini-server-shutdown-btn';
    const ACTIVE_STATES = new Set(['starting', 'running', 'recovering', 'reconnecting', 'stopping']);
    let shuttingDown = false;

    function setConnectionDisabled(message) {
        try {
            window.GeminiServerControl?.setClientLink?.(false);
        } catch (error) {
            console.warn('[GeminiShutdownUI] Could not disable Gemini client link:', error);
        }

        if (typeof window.updateConnectionStatus === 'function') {
            window.updateConnectionStatus('disconnected', message || 'Disabled');
            return;
        }

        const root = document.getElementById('connectionStatus');
        const text = document.getElementById('connectionText');
        if (root) root.dataset.status = 'disconnected';
        if (text) text.textContent = message || 'Disabled';
    }

    function isServerActive(state) {
        if (!state) return false;
        return !!state.running
            || !!state.desiredRunning
            || ACTIVE_STATES.has(String(state.serverState || ''));
    }

    function renderButton() {
        const button = document.getElementById(BUTTON_ID);
        if (!button) return;

        const control = window.GeminiServerControl;
        const state = control?.getState?.() || null;
        const controllerReady = !!state?.controllerAvailable;
        const active = isServerActive(state);
        const icon = button.querySelector('.material-icons');
        const desiredIcon = shuttingDown ? 'sync' : 'power_settings_new';

        button.disabled = shuttingDown || !control || !controllerReady || !active;
        button.classList.toggle('is-busy', shuttingDown);
        if (icon && icon.textContent !== desiredIcon) icon.textContent = desiredIcon;

        if (shuttingDown) {
            button.title = 'Shutting down Gemini server...';
            button.setAttribute('aria-label', 'Shutting down Gemini server');
        } else if (!controllerReady && active) {
            button.title = 'Gemini lifecycle controller is unavailable; server shutdown is not available from this surface.';
            button.setAttribute('aria-label', 'Gemini server shutdown unavailable');
        } else if (!active) {
            button.title = 'Gemini server is already stopped';
            button.setAttribute('aria-label', 'Gemini server already stopped');
        } else {
            button.title = 'Fully shut down the Gemini server';
            button.setAttribute('aria-label', 'Fully shut down Gemini server');
        }
    }

    async function shutdownServer() {
        if (shuttingDown) return;
        const control = window.GeminiServerControl;
        if (!control) return;

        const initialState = control.getState?.() || {};
        if (!isServerActive(initialState)) {
            setConnectionDisabled('Disabled');
            renderButton();
            return;
        }

        shuttingDown = true;
        setConnectionDisabled('Disabling Gemini Link...');
        renderButton();

        try {
            // toggleServer is the canonical lifecycle path. Unlike stop(), it also handles
            // desired/recovering states where the backend is not yet reporting running=true.
            await control.toggleServer();
            const finalState = control.getState?.() || {};
            setConnectionDisabled(finalState.running ? 'Gemini shutdown requested...' : 'Disabled');
        } catch (error) {
            console.warn('[GeminiShutdownUI] Gemini shutdown failed:', error);
            if (typeof window.updateConnectionStatus === 'function') {
                window.updateConnectionStatus('error', error?.message || 'Gemini shutdown failed');
            }
        } finally {
            shuttingDown = false;
            renderButton();
        }
    }

    function ensureButton() {
        if (document.getElementById(BUTTON_ID)) {
            renderButton();
            return;
        }

        const placeholder = document.getElementById('connection-status-placeholder');
        const connectionStatus = document.getElementById('connectionStatus');
        if (!placeholder || !connectionStatus || !placeholder.parentElement) return;

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = 'mdl-button mdl-js-button mdl-button--icon gemini-header-icon-btn';
        button.dataset.geminiServerShutdown = '1';
        button.innerHTML = '<i class="material-icons">power_settings_new</i>';
        button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            shutdownServer();
        });

        placeholder.parentElement.insertBefore(button, placeholder.nextSibling);
        if (typeof componentHandler !== 'undefined') {
            componentHandler.upgradeElement?.(button);
        }
        renderButton();
    }

    function handleGlobalStop() {
        // Search Monitor's global Stop intentionally shuts down the EveOS host. Mark the
        // Gemini link as manually disabled before the host disappears so socket-close/status
        // probes cannot reinterpret the intentional shutdown as an unexpected recovery case.
        setConnectionDisabled('Disabled');
        renderButton();
    }

    function initialize() {
        ensureButton();
        window.addEventListener('eve:gemini-server-status', renderButton);
        window.addEventListener('eve:eveos-global-stop', handleGlobalStop);

        // Watch for the header arriving late, but never re-render from mutations caused by
        // the shutdown button itself. Re-rendering here used to rewrite the icon text node,
        // which retriggered this subtree observer indefinitely and could freeze Chromium.
        const observer = new MutationObserver(function () {
            if (!document.getElementById(BUTTON_ID)) {
                ensureButton();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    window.GeminiShutdownUI = Object.freeze({
        shutdownServer,
        ensureButton,
        handleGlobalStop
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
