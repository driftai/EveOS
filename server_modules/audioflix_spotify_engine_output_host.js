'use strict';
// One route owner for the managed Engine: direct Windows OR authorized tab PCM.
const { create: createDirectRoute } = require('./audioflix_spotify_engine_direct_route.js');
const MODE_KEY = 'eveos:spotify-engine:output-mode:v1';

async function create({ page, profileDir, betaExecutable, sessionId, captureController, note, directFactory = createDirectRoute }) {
    const direct = directFactory({ profileDir, betaExecutable, note });
    let selected = null;
    let mode = await page.evaluate(key => localStorage.getItem(key) === 'capture' ? 'capture' : 'direct', MODE_KEY);
    let switching = null;
    let closed = false;
    const activeMode = () => mode;
    async function status() {
        if (mode === 'direct') return direct.status();
        const result = await captureController.status();
        return { ...result, endpoint: result?.endpoint || selected?.deviceId || '',
            label: result?.label || selected?.label || '', outputMode: 'capture' };
    }
    async function switchMode(next) {
        if (closed) throw new Error('Engine is shutting down.');
        if (!['direct', 'capture'].includes(next)) throw new Error('Unknown output mode.');
        if (switching) throw new Error('Output switch already in progress.');
        if (next === mode) return { ok: true, mode, route: await status() };
        let complete;
        switching = new Promise(resolve => { complete = resolve; });
        try {
            // Prevent audio bleeding to Speakers/CABLE during the route handoff.
            // The user must press Play again after changing output methods.
            await page.evaluate(async () => {
                const engine = window.EveAudioflixSpotifyEngine;
                if (engine?.ready) await engine.command('pause');
            });
            // Stop/verify the previous owner before arming another one.
            if (mode === 'direct') await direct.stop();
            else {
                const stopped = await captureController.stop({ sessionId });
                if (stopped?.active) throw new Error('Tab capture is still active; cannot switch output.');
            }
            if (next === 'direct' && selected) await direct.start({ sessionId, ...selected });
            if (next === 'capture' && selected) await page.evaluate(detail => {
                window.EveAudioflixSpotifyEngineCapture?.configure?.(detail);
            }, selected);
            mode = next;
            note('engine-output-mode', mode);
            return { ok: true, mode, route: await status() };
        } finally { complete(); switching = null; }
    }
    await page.exposeBinding('__eveSpotifyEngineSetOutputMode', async ({frame, page: sourcePage}, value) => {
        if (frame !== page.mainFrame() || sourcePage !== page ||
            !/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/tools\/audioflix\/spotify-engine\.html(?:\?|$)/.test(page.url())) {
            throw new Error('Output settings are available only from the trusted Engine window.');
        }
        const requested = String(value || '');
        const result = await switchMode(requested);
        if (result.ok) await page.evaluate(({key, mode: current}) => localStorage.setItem(key, current),
            { key: MODE_KEY, mode: requested });
        return result;
    });
    await page.exposeBinding('__eveSpotifyEngineGetOutputStatus', async ({frame, page: sourcePage}) => {
        if (frame !== page.mainFrame() || sourcePage !== page ||
            !/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/tools\/audioflix\/spotify-engine\.html(?:\?|$)/.test(page.url())) {
            throw new Error('Output status is only available from the Engine window.');
        }
        return {ok: true, mode, route: await status()};
    });
    async function start(payload) {
        if (closed) return { ok: false, reason: 'Engine is shutting down.' };
        if (switching) return { ok: false, reason: 'Output mode change in progress.' };
        if (String(payload?.sessionId || '') !== String(sessionId))
            return { ok: false, sessionMatch: false, reason: 'Managed browser session mismatch.' };
        const deviceId = String(payload?.deviceId || '');
        if (!/^sd:\d+$/.test(deviceId)) return { ok: false, reason: 'Exact native output required.' };
        const detail = { deviceId, label: String(payload.label || deviceId).slice(0,180) };
        if (mode === 'direct') {
            const previous = direct.status();
            if (previous.active && previous.endpoint !== deviceId) await direct.stop();
            const value = await direct.start({ sessionId, ...detail });
            selected = detail;
            return { ok: value.active === true, sessionMatch: true, capture: value,
                reason: value.active ? '' : 'Direct Windows output not initialized.' };
        }
        const output = await captureController.start(payload);
        if (output.ok) selected = detail;
        return output;
    }
    async function stop(payload) {
        if (String(payload?.sessionId || '') !== String(sessionId))
            return { ok: false, sessionMatch: false, reason: 'Managed browser session mismatch.' };
        if (mode === 'direct') return { ok: true, sessionMatch: true,
            capture: await direct.stop() };
        return captureController.stop(payload);
    }
    async function shutdown() {
        closed = true;
        // Attempt both cleanups, even after a failed transition.
        const errors = [];
        try { await captureController.stop({ sessionId }); } catch (e) { errors.push(e.message); }
        try { await direct.stop(); } catch (e) { errors.push(e.message); }
        if (errors.length) throw new Error(errors.join('; ').slice(0,200));
    }
    return { start, stop, status, shutdown, activeMode, switchMode };
}
module.exports = { create, MODE_KEY };
