(function () {
    'use strict';

    const features = new Map();
    const pending = new Map();
    let lastSignalAt = 0;

    function register(name, contract) {
        if (!name || !contract) return () => {};
        features.set(name, contract);
        try { contract.resume?.({ reason: 'register', wasDiscarded: document.wasDiscarded === true }); } catch {}
        if (pending.has(name)) {
            const detail = pending.get(name);
            pending.delete(name);
            window.setTimeout(() => contract.open?.(detail), 0);
        }
        return () => features.delete(name);
    }

    function open(name, detail) {
        const contract = features.get(name);
        if (contract?.open) {
            contract.open(detail);
            return true;
        }
        pending.set(name, detail);
        window.__loadDeferredScriptsNow?.();
        window.dispatchEvent(new CustomEvent('eve:feature-wake', { detail: { name } }));
        return false;
    }

    function signal(reason) {
        if (document.visibilityState === 'hidden') return;
        const now = Date.now();
        if (now - lastSignalAt < 180) return;
        lastSignalAt = now;
        const detail = { reason, at: now, wasDiscarded: document.wasDiscarded === true };
        window.dispatchEvent(new CustomEvent('eve:app-resume', { detail }));
        features.forEach(contract => {
            try { contract.resume?.(detail); } catch (error) { console.warn('[EveOSResume] Feature recovery failed:', error); }
        });
    }

    window.EveOSResume = Object.freeze({ register, open, signal });
    window.addEventListener('pageshow', event => signal(event.persisted ? 'page-cache' : 'page-show'));
    document.addEventListener('resume', () => signal('page-lifecycle'));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') signal('visible');
    });
    window.addEventListener('focus', () => signal('focus'));
    window.addEventListener('online', () => signal('online'));
})(window);
