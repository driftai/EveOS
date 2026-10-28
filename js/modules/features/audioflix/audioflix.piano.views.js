// Audioflix Piano presentation modes. This is UI-only state; the Piano service
// and its embedded document are shared and must never be restarted on a view switch.
(function (scope) {
    'use strict';
    const KEY = 'eveos:piano-workspace-view-v1';
    let mode = 'backend';
    try { if (sessionStorage.getItem(KEY) === 'frontend') mode = 'frontend'; } catch (_) {}

    function apply(panel) {
        if (!panel) return;
        const frontend = mode === 'frontend';
        const tools = panel.querySelector('[data-piano-backend]');
        const canvas = panel.querySelector('[data-piano-frontend]');
        panel.dataset.pianoView = mode;
        if (tools) {
            tools.inert = frontend;
            tools.setAttribute('aria-hidden', String(frontend));
        }
        if (canvas) {
            canvas.hidden = !frontend;
            canvas.inert = !frontend;
            canvas.setAttribute('aria-hidden', String(!frontend));
        }
        const heading = panel.querySelector('[data-piano-view-title]');
        if (heading) heading.textContent = frontend ? 'Piano Library' : 'Piano Auto Player - Backend';
        const toggle = panel.querySelector('[data-piano-view-switch]');
        if (toggle) {
            toggle.textContent = frontend ? 'Backend tools' : 'Frontend';
            toggle.setAttribute('aria-label', frontend ? 'Switch to Piano backend tools' : 'Switch to Piano frontend');
            toggle.setAttribute('aria-pressed', String(frontend));
            toggle.title = frontend ? 'Open Piano setup and engineering tools' : 'Open the simple Piano library and player';
        }
    }

    function toggle(panel) {
        mode = mode === 'backend' ? 'frontend' : 'backend';
        try { sessionStorage.setItem(KEY, mode); } catch (_) {}
        apply(panel);
    }

    Object.assign(scope, { apply, toggle, current: () => mode });
})(window.EveAudioflixPianoViews = window.EveAudioflixPianoViews || {});
