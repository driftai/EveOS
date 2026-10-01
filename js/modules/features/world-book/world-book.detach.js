window.EveWorldBook = window.EveWorldBook || {};

(function (ns) {
    'use strict';

    const DETACHED_WINDOW_NAME = 'eveWorldBookWindow';
    let detachedWindow = null;
    let detachedReady = false;
    let detachedView = '';
    let lastOpenState = false;

    function getWindowFeatures() {
        const availableWidth = Math.max(760, Number(window.screen?.availWidth) || 1280);
        const availableHeight = Math.max(600, Number(window.screen?.availHeight) || 820);
        const width = Math.min(1280, Math.max(760, availableWidth - 120));
        const height = Math.min(900, Math.max(600, availableHeight - 120));
        const left = Math.max(0, Math.round((availableWidth - width) / 2));
        const top = Math.max(0, Math.round((availableHeight - height) / 2));
        return [
            'popup=yes',
            `width=${width}`,
            `height=${height}`,
            `left=${left}`,
            `top=${top}`,
            'resizable=yes',
            'scrollbars=yes'
        ].join(',');
    }

    function notify(callback, value) {
        if (typeof callback === 'function') callback(value);
    }

    function state() {
        return {
            open: !!(detachedWindow && !detachedWindow.closed),
            ready: detachedReady === true,
            view: detachedView || ''
        };
    }

    function emitState(force) {
        const next = state();
        if (!force && next.open === lastOpenState) return next;
        lastOpenState = next.open;
        if (!next.open) {
            detachedReady = false;
            detachedView = '';
        }
        window.dispatchEvent(new CustomEvent('eve:world-book-detached-state', { detail: next }));
        return next;
    }

    function markLoading(target) {
        if (!target) return;
        window.dispatchEvent(new CustomEvent('eve:world-book-frame-loading', { detail: { target } }));
    }

    function renderPlaceholder(target, title, message, isError) {
        try {
            const doc = target.document;
            doc.title = title;
            doc.body.replaceChildren();
            Object.assign(doc.documentElement.style, {
                colorScheme: 'dark',
                background: '#061014'
            });
            Object.assign(doc.body.style, {
                minHeight: '100vh',
                margin: '0',
                display: 'grid',
                placeItems: 'center',
                background: 'radial-gradient(circle, #10353b 0, #061014 48%, #020608 100%)',
                color: '#d9fbff',
                fontFamily: 'Georgia, serif'
            });
            const panel = doc.createElement('main');
            Object.assign(panel.style, {
                width: 'min(520px, calc(100vw - 48px))',
                padding: '32px',
                boxSizing: 'border-box',
                border: `1px solid ${isError ? '#a45d57' : '#337c84'}`,
                borderRadius: '18px',
                background: 'rgba(4, 17, 21, 0.92)',
                textAlign: 'center',
                boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)'
            });
            const heading = doc.createElement('h1');
            heading.textContent = title;
            heading.style.margin = '0 0 12px';
            heading.style.fontSize = '1.35rem';
            const copy = doc.createElement('p');
            copy.textContent = message;
            copy.style.margin = '0';
            copy.style.color = isError ? '#ffb0aa' : '#9acbd0';
            copy.style.fontFamily = 'sans-serif';
            copy.style.lineHeight = '1.6';
            panel.append(heading, copy);
            doc.body.appendChild(panel);
        } catch (error) {
            // The popup may have navigated or closed while status was resolving.
        }
    }

    async function prepare(target, options) {
        if (options.view === 'notes') {
            if (!target || target.closed || target !== detachedWindow) return null;
            detachedReady = true;
            detachedView = 'notes';
            emitState(true);
            const targetUrl = new URL(window.location.href);
            targetUrl.searchParams.set('eveNotesDetached', '1');
            targetUrl.hash = '';
            target.location.href = targetUrl.href;
            target.focus();
            notify(options.onReady, { running: true, service: 'eveos-notes' });
            return target;
        }
        const snapshot = await ns.client.refresh();
        notify(options.onSnapshot, snapshot);
        if (!target || target.closed || target !== detachedWindow) return null;
        if (!snapshot.running) {
            detachedReady = false;
            markLoading(target);
            const guidance = snapshot.controllerAvailable
                ? 'Start World Book in EveOS, then choose Detach again.'
                : 'Run tools\\World-Book\\launch.bat, then choose Detach again.';
            renderPlaceholder(target, options.view === 'portal' ? 'World Portal is resting' : 'World Book is resting', guidance, true);
            notify(options.onMessage, guidance);
            return target;
        }

        detachedReady = true;
        detachedView = options.view || 'world';
        emitState(true);
        markLoading(target);
        const baseUrl = snapshot.url || ns.client.state.url;
        target.location.href = detachedView === 'portal'
            ? `${String(baseUrl).replace(/\/$/, '')}/?view=world-portal&embedded=1`
            : baseUrl;
        target.focus();
        notify(options.onReady, snapshot);
        return target;
    }

    function open(options = {}) {
        if (detachedWindow && !detachedWindow.closed && detachedReady
            && detachedView === (options.view || 'world')) {
            detachedWindow.focus();
            notify(options.onReady, ns.client.state);
            return detachedWindow;
        }

        if (!detachedWindow || detachedWindow.closed) {
            detachedReady = false;
            detachedWindow = window.open(
                'about:blank',
                DETACHED_WINDOW_NAME,
                getWindowFeatures()
            );
            emitState(true);
        }

        if (!detachedWindow) {
            notify(options.onMessage, 'Window blocked - allow pop-ups to detach World Book');
            return null;
        }

        renderPlaceholder(
            detachedWindow,
            options.view === 'notes' ? 'Opening Notes' : options.view === 'portal' ? 'Opening World Portal' : 'Opening World Book',
            options.view === 'notes' ? 'Opening the independent Notes workspace…' : 'Verifying the local World Book service...',
            false
        );
        detachedWindow.focus();
        void prepare(detachedWindow, options);
        return detachedWindow;
    }

    window.setInterval(() => emitState(false), 1000);
    document.addEventListener('click', (event) => {
        const button = event.target.closest?.('.topbar-notes-world-book-btn');
        if (!button || !state().open) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        try { detachedWindow.focus(); } catch {}
    }, true);

    ns.detached = Object.freeze({
        open,
        state,
        isOpen: () => state().open,
        getWindow: () => detachedWindow
    });
})(window.EveWorldBook);
