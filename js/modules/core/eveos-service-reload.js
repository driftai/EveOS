/* Shared explicit reload for running services; status refresh never invokes this API. */
(function () {
    'use strict';
    if (window.EveOSServiceReload) return;
    const pending = new Map();

    async function request(service, options) {
        const control = window.EveOSLocalControl;
        if (!control?.health || !control?.fetchJson) throw new Error('EveOS Local Control is unavailable.');
        await control.health(3000);
        let query = '';
        if (service === 'web') {
            const port = Number(options?.port || window.location?.port || 0);
            if (Number.isInteger(port) && port > 0 && port <= 65535) query = `?port=${port}`;
        }
        const response = await control.fetchJson(`${control.baseUrl()}/api/services/restart${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service })
        }, 90000);
        const payload = response?.payload || response;
        if (payload?.ok !== true) throw new Error(payload?.message || `${service} restart failed.`);
        window.dispatchEvent(new CustomEvent('eve:eveos-service-reload', { detail: payload }));
        return payload;
    }

    function restart(service, options) {
        const key = String(service || '');
        if (pending.has(key)) return pending.get(key);
        const promise = request(key, options).finally(() => pending.delete(key));
        pending.set(key, promise);
        return promise;
    }

    window.EveOSServiceReload = Object.freeze({ restart, isBusy: (service) => pending.has(String(service)) });
})();
