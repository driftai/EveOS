'use strict';

const LAUNCH_ARGS = Object.freeze([
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
    '--auto-select-tab-capture-source-by-title=EveOS Spotify Engine'
]);

function create({ getPage, sameSession }) {
    async function status() {
        const page = getPage();
        if (!page || page.isClosed()) return { state: 'unavailable', active: false };
        return page.evaluate(() => window.EveAudioflixSpotifyEngineCapture?.status?.()
            || { state: 'unavailable', active: false }).catch((error) => ({
                state: 'error', active: false, message: String(error?.message || error).slice(0, 200)
            }));
    }

    async function start(body) {
        if (!sameSession(body?.sessionId)) return { ok: false, sessionMatch: false, reason: 'Managed browser session mismatch.' };
        const deviceId = String(body?.deviceId || '').trim();
        const label = String(body?.label || deviceId).trim().slice(0, 180);
        if (!deviceId.startsWith('sd:')) return { ok: false, reason: 'An exact native output endpoint is required.' };
        const page = getPage();
        if (!page || page.isClosed()) return { ok: false, reason: 'Managed Spotify engine page is unavailable.' };
        await page.evaluate((detail) => window.EveAudioflixSpotifyEngineCapture?.configure?.(detail), { deviceId, label });
        await page.locator('#spotify-engine-capture-route').click({ timeout: 5000 });
        await page.waitForFunction(() => {
            const value = window.EveAudioflixSpotifyEngineCapture?.status?.() || {};
            return value.active === true || value.state === 'error';
        }, null, { timeout: 15000 });
        const capture = await status();
        return { ok: capture.active === true && capture.endpoint === deviceId, sessionMatch: true, capture,
            reason: capture.active === true ? '' : (capture.message || 'Managed Spotify capture did not start.') };
    }

    async function stop(body) {
        if (!sameSession(body?.sessionId)) return { ok: false, sessionMatch: false, reason: 'Managed browser session mismatch.' };
        const page = getPage();
        if (!page || page.isClosed()) return { ok: true, sessionMatch: true, capture: { state: 'idle', active: false } };
        const capture = await page.evaluate(() => window.EveAudioflixSpotifyEngineCapture?.stop?.());
        return { ok: true, sessionMatch: true, capture };
    }

    return { status, start, stop };
}

module.exports = { LAUNCH_ARGS, create };
