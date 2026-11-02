// Current-tab PCM capture for the isolated managed Spotify engine.
window.EveAudioflixSpotifyEngineCapture = window.EveAudioflixSpotifyEngineCapture || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;

    let configured = null;
    let task = null;
    const button = document.createElement('button');
    button.id = 'spotify-engine-capture-route';
    button.type = 'button';
    button.hidden = true;
    button.textContent = 'Route Spotify audio through EveOS';
    button.title = 'Captures this managed Spotify tab and sends its PCM to the exact EveOS native output.';
    Object.assign(button.style, {
        width: '100%', marginTop: '10px', padding: '9px 12px', borderRadius: '8px', cursor: 'pointer',
        border: '1px solid #41d6ef', background: '#0b3540', color: '#dffaff', font: '700 13px system-ui,sans-serif'
    });

    function status() {
        return window.EveAudioflixProviderCapture?.getStatus?.() || { state: 'unavailable', active: false };
    }
    function configure(detail = {}) {
        const deviceId = String(detail.deviceId || '').trim();
        if (!deviceId.startsWith('sd:')) throw new Error('Managed Spotify capture requires an exact native output.');
        configured = { deviceId, label: String(detail.label || deviceId).trim() };
        button.hidden = false;
        button.textContent = `Route Spotify to ${configured.label}`;
        return { ok: true, endpoint: configured.deviceId };
    }
    async function start() {
        if (!configured) throw new Error('No managed Spotify capture endpoint is configured.');
        if (task) return task;
        if (status().active === true && status().endpoint === configured.deviceId) return status();
        button.disabled = true;
        button.textContent = 'Starting EveOS PCM route…';
        task = window.EveAudioflixProviderCapture.armProviderTab({
            source: 'managed-spotify', targetTitle: 'this managed Spotify tab',
            endpoint: configured, gainMode: 'unity', preferCurrentTab: true
        });
        try {
            const result = await task;
            button.textContent = `Spotify routed to ${configured.label}`;
            return result;
        } catch (error) {
            button.textContent = 'Retry Spotify PCM route';
            throw error;
        } finally {
            task = null;
            button.disabled = false;
        }
    }
    async function stop() {
        await window.EveAudioflixProviderCapture?.stop?.('managed-engine-stop');
        if (configured) button.textContent = `Route Spotify to ${configured.label}`;
        return status();
    }
    button.addEventListener('click', () => { start().catch(() => {}); });
    document.querySelector('main')?.appendChild(button);
    Object.assign(ns, { ready: true, configure, start, stop, status, button });
})(window.EveAudioflixSpotifyEngineCapture);
