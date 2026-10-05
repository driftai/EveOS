(function () {
    'use strict';

    const STATUS_PATH = '/api/gemini-credentials/status';
    const SAVE_PATH = '/api/gemini-credentials';
    const STATUS_CACHE_MS = 1500;
    let lastSyncedKey = '';
    let statusRequest = null;
    let statusCache = null;
    let statusCacheAt = 0;
    let statusCacheBaseUrl = '';

    function getSavedBrowserKey() {
        try {
            return String(localStorage.getItem('geminiApiKey') || '').trim();
        } catch (error) {
            return '';
        }
    }

    async function fetchJson(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = window.setTimeout(function () {
            controller.abort();
        }, timeoutMs || 1800);
        try {
            const response = await fetch(url, {
                cache: 'no-store',
                ...options,
                signal: controller.signal
            });
            const payload = await response.json().catch(function () {
                return {};
            });
            if (!response.ok) {
                throw new Error(payload.message || `Credential request failed (${response.status})`);
            }
            return payload;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function rememberStatus(baseUrl, payload) {
        statusCacheBaseUrl = baseUrl;
        statusCache = payload;
        statusCacheAt = Date.now();
        return payload;
    }

    async function getStatus(baseUrl, options) {
        if (!baseUrl) return { ok: false, configured: false };

        const force = !!options?.force;
        const now = Date.now();
        if (!force
            && statusCache
            && statusCacheBaseUrl === baseUrl
            && now - statusCacheAt < STATUS_CACHE_MS) {
            return statusCache;
        }

        if (!force && statusRequest?.baseUrl === baseUrl) {
            return statusRequest.promise;
        }

        const promise = fetchJson(`${baseUrl}${STATUS_PATH}`, null, 1200)
            .then(function (payload) {
                return rememberStatus(baseUrl, payload);
            });
        statusRequest = { baseUrl, promise };
        try {
            return await promise;
        } finally {
            if (statusRequest?.promise === promise) statusRequest = null;
        }
    }

    async function save(baseUrl, apiKey) {
        const normalizedKey = String(apiKey || '').trim();
        if (!baseUrl || !normalizedKey) {
            throw new Error('Enter a Gemini API key before saving.');
        }
        const payload = await fetchJson(`${baseUrl}${SAVE_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey: normalizedKey })
        }, 2500);
        if (payload.configured) {
            lastSyncedKey = normalizedKey;
            rememberStatus(baseUrl, payload);
            try {
                localStorage.removeItem('geminiApiKey');
            } catch (error) {
                // The encrypted server vault is still the durable credential source.
            }
        } else {
            statusCache = null;
            statusCacheAt = 0;
            statusCacheBaseUrl = '';
        }
        return payload;
    }

    async function sync(baseUrl, options) {
        if (!baseUrl) {
            return getStatus(baseUrl);
        }

        const force = !!options?.force;
        let status = null;
        if (!force) {
            status = await getStatus(baseUrl);
            if (status?.configured) {
                try {
                    localStorage.removeItem('geminiApiKey');
                } catch (error) {
                    // Secure vault remains the durable source.
                }
                return status;
            }
        }

        const apiKey = String(options?.apiKey || getSavedBrowserKey()).trim();
        if (!apiKey) {
            return status || getStatus(baseUrl, { force });
        }
        if (!force && apiKey === lastSyncedKey) {
            return { ok: true, configured: true, cached: true };
        }
        return save(baseUrl, apiKey);
    }

    window.GeminiCredentialBridge = {
        getStatus,
        save,
        sync,
        hasBrowserKey: function () {
            return !!getSavedBrowserKey();
        }
    };
})();
