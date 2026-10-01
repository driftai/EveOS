window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    let overlay = null;

    function render(snapshot = ns.notesClient?.state || {}) {
        if (!overlay) return;
        const pill = overlay.querySelector('[data-notes-service-pill]');
        const toggle = overlay.querySelector('[data-notes-service-toggle]');
        const running = snapshot.running === true;
        if (pill) {
            pill.dataset.state = snapshot.serverState || 'stopped';
            pill.textContent = running ? 'Notes online' : snapshot.serverState === 'starting'
                ? 'Notes starting' : snapshot.serverState === 'blocked' ? 'Notes blocked' : 'Notes offline';
            pill.title = snapshot.message || '';
        }
        if (toggle) {
            toggle.disabled = snapshot.busy === true;
            toggle.textContent = running ? 'Stop Notes' : 'Start Notes';
            toggle.title = running ? 'Stop only the Notes service' : 'Start only the Notes service';
        }
        if (overlay.dataset.view === 'notes') {
            const status = overlay.querySelector('[data-world-book-status]');
            if (status) status.textContent = snapshot.message || 'Scratchpad is offline-ready.';
        }
    }

    async function toggle() {
        const client = ns.notesClient;
        if (!client) return;
        render(client.state);
        render(client.state.running ? await client.stop() : await client.start());
        if (client.state.running) await ns.notesWorkspace?.resume?.();
    }

    function bind(target) {
        overlay = target;
        const button = overlay?.querySelector('[data-notes-service-toggle]');
        if (!button || button.dataset.notesLifecycleBound === '1') return;
        button.dataset.notesLifecycleBound = '1';
        button.addEventListener('click', () => void toggle());
        render();
        void ns.notesClient?.refresh?.().then(render);
    }

    window.addEventListener('eve:notes-status', event => render(event.detail));
    ns.notesLifecycle = Object.freeze({ bind, render, toggle });
})(window.EveWorldBook);
