'use strict';

const ALLOWED_ACTIONS = new Set(['status', 'load', 'play', 'resume', 'pause', 'seek', 'stop', 'restart']);

function safeText(value, max = 240) {
    return String(value ?? '').trim().slice(0, max);
}

function sanitizePayload(body = {}) {
    return {
        spotifyId: safeText(body.spotifyId || body.trackId || body.url || body.uri, 512),
        title: safeText(body.title, 240),
        duration: Math.max(0, Number(body.duration || 0) || 0),
        seconds: Math.max(0, Number(body.seconds || 0) || 0),
        generation: Math.max(0, Number(body.generation || 0) || 0)
    };
}

async function waitForEngine(page, timeoutMs = 12000) {
    if (!page || page.isClosed()) throw new Error('Managed Spotify engine page is not attached.');
    await page.waitForFunction(
        () => window.EveAudioflixSpotifyEngine?.ready === true,
        undefined,
        { timeout: timeoutMs }
    );
}

async function engineSnapshot(page) {
    await waitForEngine(page);
    return page.evaluate(() => window.EveAudioflixSpotifyEngine.snapshot());
}

async function engineCommand(page, body = {}) {
    const action = safeText(body.action, 40).toLowerCase();
    if (!ALLOWED_ACTIONS.has(action)) {
        return { ok: false, reason: `Unsupported Spotify engine action: ${action || '(empty)'}` };
    }
    await waitForEngine(page);
    const payload = sanitizePayload(body);
    try {
        const state = await page.evaluate(async ({ actionName, data }) => {
            const engine = window.EveAudioflixSpotifyEngine;
            if (!engine?.ready) throw new Error('Spotify engine is not ready.');
            return engine.command(actionName, data);
        }, { actionName: action, data: payload });
        return { ok: true, action, state };
    } catch (error) {
        return { ok: false, action, reason: safeText(error?.message || error, 300) };
    }
}

module.exports = { ALLOWED_ACTIONS, sanitizePayload, waitForEngine, engineSnapshot, engineCommand };
