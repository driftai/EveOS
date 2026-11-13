// Output mode picker shown inside the managed Edge Beta Engine window.
// Direct Windows routing is the default; tab capture stays explicitly available.
(() => {
    'use strict';
    if (new URLSearchParams(location.search).get('surface') === 'mirror') return;
    if (document.querySelector('[data-spotify-engine-output]')) return;
    const KEY = 'eveos:spotify-engine:output-mode:v1';
    const box = document.createElement('section');
    box.dataset.spotifyEngineOutput = 'true';
    box.setAttribute('aria-label', 'Spotify Engine audio output');
    box.style.cssText = 'border:1px solid #4c6982;background:#162332;border-radius:12px;padding:12px;margin:12px 0;color:#fff;font:13px system-ui';
    box.innerHTML = '<strong>Engine audio output</strong>' +
        '<p style="opacity:.82;margin:8px 0">Direct Windows Output uses the native destination selected in EveOS. No sharing prompt.</p>' +
        '<label for="eve-engine-output-mode">Default output method</label>' +
        '<select id="eve-engine-output-mode" style="display:block;width:100%;padding:8px;margin-top:6px;background:#202f44;color:white;border:1px solid #6f8099;border-radius:8px">' +
        '<option value="direct">Direct Windows Output (Edge Beta)</option>' +
        '<option value="capture">Authorized Tab Capture (existing PCM)</option>' +
        '</select>' +
        '<p data-spotify-output-status role="status" style="margin:8px 0 0;opacity:.84">Connecting to the engine...</p>';
    document.querySelector('main')?.appendChild(box);
    const select = box.querySelector('select');
    const status = box.querySelector('[data-spotify-output-status]');
    let stored = 'direct';
    try { if (localStorage.getItem(KEY) === 'capture') stored = 'capture'; } catch {}
    select.value = stored;
    let busy = false;
    const note = text => { status.textContent = text; };
    async function refresh() {
        if (busy || typeof window.__eveSpotifyEngineGetOutputStatus !== 'function') return;
        const info = await window.__eveSpotifyEngineGetOutputStatus().catch(() => null);
        if (!info?.ok) return;
        select.value = info.mode;
        const capture = document.querySelector('#spotify-engine-capture-route');
        if (capture) capture.hidden = info.mode !== 'capture' || !info.route?.endpoint;
        const health = info.route || {};
        if (info.mode === 'direct') note(health.routeConfirmed ?
            `Direct output confirmed: ${health.label || health.endpoint || 'selected output'}` :
            health.active ? `Direct output armed; ${health.state || 'waiting for audio session'}` :
            'Direct output selected. Play a song in EveOS to arm the selected native port.');
        else note(health.active ? 'Authorized tab capture is active.' :
            'Capture selected. Use “Route Spotify to...” below to authorize this tab.');
    }
    select.addEventListener('change', async () => {
        if (busy) return;
        const prior = stored, next = select.value;
        if (next === prior) return;
        if (typeof window.__eveSpotifyEngineSetOutputMode !== 'function') {
            select.value = prior; note('Engine connection not ready. Retry after startup.'); return;
        }
        busy = true; select.disabled = true;
        note('Releasing the previous audio route...');
        try {
            const result = await window.__eveSpotifyEngineSetOutputMode(next);
            if (!result?.ok) throw new Error(result?.reason || 'Output change not accepted.');
            stored = next;
            try { localStorage.setItem(KEY, next); } catch {}
        } catch (error) {
            select.value = prior;
            note(`Output unchanged: ${String(error?.message || error).slice(0,140)}`);
        } finally {
            busy = false; select.disabled = false;
            await refresh();
        }
    });
    const timer = setInterval(() => { refresh().catch(() => {}); }, 2200);
    window.addEventListener('pagehide', () => clearInterval(timer), { once:true });
    refresh().catch(() => {});
})();
