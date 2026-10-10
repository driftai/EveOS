'use strict';

const { createHash } = require('node:crypto');
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PLAYBACK_PATHS = new Set([
    '/api/audioflix/spotify-client/connect', '/api/audioflix/spotify-client/pair-status',
    '/api/audioflix/spotify-client/command', '/api/audioflix/spotify-client/status-watch',
    '/api/audioflix/spotify-browser/start', '/api/audioflix/spotify-browser/stop',
    '/api/audioflix/spotify-browser/presentation', '/api/audioflix/spotify-browser/volume',
    '/api/audioflix/spotify-browser/session-status'
]);
const PLAYBACK_ACTIONS = new Set([
    'play', 'pause', 'resume', 'stop', 'seek', 'restart', 'volume', 'status', 'status-watch',
    'release', 'detach', 'take-control', 'engine-presentation', 'engine-stop'
]);
const BLOCKED_BY = 'audioflix-live-isolation';
function isLoopback(url) {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1'
        || /^127\.\d+\.\d+\.\d+$/.test(host) || /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host);
}
const endpoint = (url) => `${url.protocol}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;

function validateBackendUrls(backendUrls) {
    return new Set(backendUrls.map((raw) => {
        const url = new URL(raw);
        if (!/^https?:$/.test(url.protocol) || !isLoopback(url)) throw new Error('Isolation requires loopback EveOS backends.');
        return endpoint(url);
    }));
}
async function installBackendWriteBarrier(context, backendUrls) {
    const endpoints = validateBackendUrls(backendUrls);
    const probeUrl = new URL('/api/eve-state/modular/save', backendUrls[0]).href;
    let blockedCount = 0, allowedPlaybackCount = 0;
    const blocked = new Map();
    await context.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url()), method = request.method().toUpperCase();
        if (!/^https?:$/.test(url.protocol) || !isLoopback(url) || READ_METHODS.has(method)) return route.fallback();
        let allowed = method === 'POST' && endpoints.has(endpoint(url)) && PLAYBACK_PATHS.has(url.pathname);
        if (allowed && url.pathname === '/api/audioflix/spotify-client/command') {
            try { allowed = PLAYBACK_ACTIONS.has(String(request.postDataJSON()?.command?.action || '').toLowerCase()); }
            catch { allowed = false; }
        }
        if (allowed) { allowedPlaybackCount += 1; return route.fallback(); }
        blockedCount += 1;
        const key = `${method} ${url.pathname}`;
        if (blocked.has(key) || blocked.size < 16) blocked.set(key, (blocked.get(key) || 0) + 1);
        return route.fulfill({ status: 403, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ ok: false, blockedBy: BLOCKED_BY, reason: 'Disposable live fixture cannot mutate the backend.' }) });
    });
    return {
        summary: () => ({ blockedCount, allowedPlaybackCount, blocked: Object.fromEntries(blocked) }),
        async proveBlocked(page) {
            const result = await page.evaluate(async (url) => {
                // Invalid unified-state input remains harmless even if a future barrier regresses.
                const response = await fetch(url, {
                    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"isolationProbe":true}'
                });
                return { status: response.status, body: await response.json() };
            }, probeUrl);
            if (result.status !== 403 || result.body?.blockedBy !== BLOCKED_BY || blockedCount < 1) {
                throw new Error('Live fixture backend write barrier did not prove denial.');
            }
        }
    };
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
}
async function readBackendAudioflixSnapshot(readResponse) {
    const response = await readResponse();
    if (response?.ok !== true || (response.state !== null && (typeof response.state !== 'object' || Array.isArray(response.state)))) {
        throw new Error('Canonical backend Audioflix snapshot is unavailable; refusing an unguarded live proof.');
    }
    const audioflix = response.state?.audioflix ?? response.state?.bookmarks?.config?.audioflix ?? null;
    if (audioflix !== null && (typeof audioflix !== 'object' || Array.isArray(audioflix))) {
        throw new Error('Canonical backend Audioflix snapshot is malformed.');
    }
    const structure = response.state?.audioflixStructure ?? null;
    return { digest: createHash('sha256').update(JSON.stringify(canonical({ audioflix, structure }))).digest('hex'),
        musicCount: audioflix?.music?.length || 0, groupCount: audioflix?.musicGroups?.length || 0 };
}
function assertBackendAudioflixUnchanged(before, after) {
    if (before.digest !== after.digest) throw new Error(`Canonical backend Audioflix changed during isolated live proof: ${before.digest} -> ${after.digest}. No user state was restored or cleaned.`);
}
module.exports = { validateBackendUrls, installBackendWriteBarrier, readBackendAudioflixSnapshot, assertBackendAudioflixUnchanged };
