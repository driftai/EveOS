'use strict';

/*
 * EveOS managed Spotify browser helper.
 *
 * This process owns one persistent Spotify browser profile and one helper-owned engine page.
 * Browser clients never receive its port, token, or private session id. The helper exposes only
 * fixed commands; there is no arbitrary evaluate endpoint.
 */
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const SERVICE = 'eveos-audioflix-spotify-browser';
const PROTOCOL_VERSION = 2;
const MAX_DIAGNOSTICS = 32;
const TOKEN_HEADER = 'x-eveos-spotify-token';
const { MAX_MEDIA_REFS, browserInit } = require('./audioflix_spotify_browser_hook.js');
const { scrapeManagedPlaylist } = require('./audioflix_spotify_managed_import.js');
const { engineSnapshot } = require('./audioflix_spotify_browser_transport.js');
const {
    headlessRequestedFromPageUrl, isLikelyPlayControl, handleTransportWithActivation
} = require('./audioflix_spotify_playback_activation.js');

function clampVolume(value, fallback = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return Math.max(0, Math.min(1, Number(fallback) || 0));
    return Math.max(0, Math.min(1, n));
}
function normalizeTrackId(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)?([A-Za-z0-9]{22})(?:[?/#]|$)?/i);
    return match ? match[1] : '';
}
function isLoopbackHostname(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
function validateLoopbackPageUrl(value) {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch { return false; }
    return /^https?:$/.test(parsed.protocol) && isLoopbackHostname(parsed.hostname);
}
function isSpotifyEmbedUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        return parsed.protocol === 'https:'
            && parsed.hostname.toLowerCase() === 'open.spotify.com'
            && parsed.pathname.startsWith('/embed/');
    } catch { return false; }
}
function spotifyFrameTrackId(value) {
    try {
        const parsed = new URL(String(value || ''));
        if (parsed.hostname.toLowerCase() !== 'open.spotify.com') return '';
        return parsed.pathname.match(/^\/embed\/track\/([A-Za-z0-9]{22})(?:\/|$)/i)?.[1] || '';
    } catch { return ''; }
}
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const current = argv[i];
        if (!current.startsWith('--')) continue;
        const [rawKey, inline] = current.slice(2).split('=', 2);
        if (inline !== undefined) out[rawKey] = inline;
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[rawKey] = argv[++i];
        else out[rawKey] = '1';
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const port = Number(args.port || 0);
    const profileDir = path.resolve(String(args.profile || ''));
    const pageUrl = String(args.page || 'http://127.0.0.1:8765/audioflix-spotify-engine.html');
    const headlessRequested = headlessRequestedFromPageUrl(pageUrl);
    const sessionId = String(args.session || '');
    const token = String(process.env.EVEOS_SPOTIFY_BROWSER_TOKEN || '');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('A valid helper --port is required.');
    if (!profileDir || profileDir === path.parse(profileDir).root) throw new Error('A dedicated Spotify --profile directory is required.');
    if (!validateLoopbackPageUrl(pageUrl)) throw new Error('The managed Spotify engine page must use a loopback http(s) URL.');
    if (!sessionId || sessionId.length < 8) throw new Error('A private helper session id is required.');
    if (!token || token.length < 20) throw new Error('EVEOS_SPOTIFY_BROWSER_TOKEN is required.');

    let chromium;
    let playwrightVersion = '';
    try {
        ({ chromium } = require('playwright'));
        try { playwrightVersion = require('playwright/package.json').version || ''; } catch {}
    } catch (error) {
        throw new Error(`Playwright is unavailable: ${error.message}`);
    }

    const diagnostics = [];
    const note = (kind, message) => {
        diagnostics.push({ at: Date.now(), kind: String(kind), message: String(message || '').slice(0, 240) });
        if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
    };
    const runtime = {
        startedAt: Date.now(), state: 'starting', pageUrl, desiredVolume: 1,
        lastAppliedAt: 0, lastError: '', browserChannel: '', authState: 'unknown',
        closing: false, importing: false, headless: headlessRequested,
        playbackKickCount: 0, lastPlaybackKickAt: 0
    };
    const launchOptions = {
        headless: headlessRequested,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        ignoreDefaultArgs: ['--disable-component-update', '--enable-automation'],
        args: [
            '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--lang=en-US',
            '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
            '--disable-features=CalculateNativeWinOcclusion', '--window-position=80,80', '--window-size=1280,900'
        ]
    };

    let context;
    if (process.platform === 'win32') {
        try {
            context = await chromium.launchPersistentContext(profileDir, { ...launchOptions, channel: 'msedge' });
            runtime.browserChannel = headlessRequested ? 'msedge-headless' : 'msedge';
        } catch (edgeError) {
            note('launch', `Edge unavailable: ${edgeError.message}`);
            context = await chromium.launchPersistentContext(profileDir, launchOptions);
            runtime.browserChannel = headlessRequested ? 'playwright-chromium-headless' : 'playwright-chromium';
        }
    } else {
        context = await chromium.launchPersistentContext(profileDir, launchOptions);
        runtime.browserChannel = headlessRequested ? 'playwright-chromium-headless' : 'playwright-chromium';
    }

    await context.addInitScript(browserInit, { maxRefs: MAX_MEDIA_REFS, initialVolume: 1 });
    context.on('page', (p) => {
        p.on('crash', () => note('page-crash', p.url()));
        p.on('close', () => note('page-close', p.url()));
    });

    let page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    runtime.state = 'ready';

    async function authState() {
        try {
            const cookies = await context.cookies('https://open.spotify.com');
            const signedIn = cookies.some((cookie) => /^(sp_dc|sp_key)$/i.test(cookie.name));
            runtime.authState = signedIn ? 'signed-in' : 'unknown';
        } catch (error) {
            runtime.lastError = String(error?.message || error).slice(0, 240);
            runtime.authState = 'unknown';
        }
        return runtime.authState;
    }

    async function spotifySnapshots(setVolume = null, trackId = '') {
        if (!page || page.isClosed()) return [];
        const normalizedTrack = normalizeTrackId(trackId);
        const out = [];
        for (const frame of page.frames()) {
            const frameUrl = frame.url();
            if (!isSpotifyEmbedUrl(frameUrl)) continue;
            const frameTrack = spotifyFrameTrackId(frameUrl);
            if (normalizedTrack && frameTrack && frameTrack !== normalizedTrack) continue;
            try {
                const snap = await frame.evaluate(({ volume }) => {
                    const control = window.__eveSpotifyManagedControl;
                    if (!control) return null;
                    return volume == null ? control.snapshot() : control.setVolume(volume);
                }, { volume: setVolume });
                if (snap) out.push({ url: frameUrl, trackId: frameTrack, ...snap });
            } catch (error) {
                note('frame-evaluate', `${frameUrl}: ${error.message}`);
            }
        }
        return out;
    }

    async function status() {
        const snapshots = await spotifySnapshots(null, '');
        const mediaCount = snapshots.reduce((sum, item) => sum + Number(item.mediaCount || 0), 0);
        const playingCount = snapshots.reduce((sum, item) => sum + Number(item.playingCount || 0), 0);
        let transport = null;
        try { transport = await engineSnapshot(page); } catch {}
        if (runtime.importing) runtime.state = 'importing';
        else if (!page || page.isClosed()) runtime.state = 'page-closed';
        else if (playingCount > 0) runtime.state = 'controlling';
        else if (transport?.status) runtime.state = transport.status;
        else runtime.state = 'ready';
        await authState();
        return {
            ok: true, service: SERVICE, protocolVersion: PROTOCOL_VERSION,
            sessionId, state: runtime.state, startedAt: runtime.startedAt,
            pageUrl: page && !page.isClosed() ? page.url() : runtime.pageUrl,
            pageAttached: Boolean(page && !page.isClosed()), spotifyFrameCount: snapshots.length,
            mediaCount, playingCount, desiredVolume: runtime.desiredVolume,
            lastAppliedAt: runtime.lastAppliedAt, lastError: runtime.lastError,
            authState: runtime.authState, browserChannel: runtime.browserChannel, playwrightVersion,
            headless: runtime.headless, playbackKickCount: runtime.playbackKickCount,
            lastPlaybackKickAt: runtime.lastPlaybackKickAt,
            profileOpen: true, importing: runtime.importing, transport,
            diagnostics: diagnostics.slice(-8)
        };
    }

    function sameSession(candidate) {
        const actual = Buffer.from(String(candidate || ''));
        const expected = Buffer.from(sessionId);
        if (actual.length !== expected.length) return false;
        try { return crypto.timingSafeEqual(actual, expected); } catch { return false; }
    }

    async function applyVolume(body) {
        if (!sameSession(body?.sessionId)) {
            return { ok: false, sessionMatch: false, reason: 'Managed browser session mismatch.' };
        }
        const trackId = normalizeTrackId(body?.trackId || '');
        const volume = clampVolume(body?.volume, runtime.desiredVolume);
        runtime.desiredVolume = volume;
        const snapshots = await spotifySnapshots(volume, trackId);
        const mediaCount = snapshots.reduce((sum, item) => sum + Number(item.mediaCount || 0), 0);
        const playingCount = snapshots.reduce((sum, item) => sum + Number(item.playingCount || 0), 0);
        const reached = snapshots.reduce((sum, item) => sum + Number(item.reached || 0), 0);
        const playingVolumes = snapshots.flatMap((item) => item.media || [])
            .filter((item) => !item.paused && !item.ended && Number.isFinite(Number(item.volume)))
            .map((item) => Number(item.volume));
        const held = playingVolumes.length === 0 || playingVolumes.every((value) => Math.abs(value - volume) <= 0.011);
        runtime.lastAppliedAt = Date.now();
        runtime.state = playingCount > 0 ? 'controlling' : snapshots.length ? 'spotify-ready' : 'ready';
        return {
            ok: true, sessionMatch: true, volume, trackId, spotifyFrameCount: snapshots.length,
            mediaCount, playingCount, reached, held, playingVolumes, lastAppliedAt: runtime.lastAppliedAt
        };
    }

    async function importPlaylist(body) {
        if (runtime.importing) return { ok: false, reason: 'A Spotify playlist import is already running.' };
        const url = String(body?.url || '').trim();
        runtime.importing = true;
        runtime.state = 'importing';
        note('playlist-import', 'started');
        try {
            const result = await scrapeManagedPlaylist(context, url);
            runtime.lastError = '';
            note('playlist-import', `completed ${Number(result?.count || 0)} tracks`);
            return result;
        } catch (error) {
            runtime.lastError = String(error?.message || error).slice(0, 240);
            note('playlist-import-error', runtime.lastError);
            return { ok: false, reason: runtime.lastError };
        } finally { runtime.importing = false; }
    }

    async function openManagedPage(body) {
        const next = String(body?.pageUrl || runtime.pageUrl || pageUrl);
        if (!validateLoopbackPageUrl(next)) return { ok: false, reason: 'Managed page must be a loopback URL.' };
        if (!page || page.isClosed()) page = await context.newPage();
        await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 30000 });
        runtime.pageUrl = next;
        runtime.state = 'ready';
        return status();
    }

    async function openAuth(body) {
        const requested = String(body?.url || 'https://open.spotify.com/').trim();
        let target = 'https://open.spotify.com/';
        try {
            const parsed = new URL(requested);
            if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'open.spotify.com') target = parsed.href;
        } catch {}
        if (body?.openLogin === true) {
            const authPage = await context.newPage();
            await authPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await authPage.bringToFront();
        }
        return { ok: true, authState: await authState(), loginWindowOpened: body?.openLogin === true };
    }

    function authorized(req) {
        const candidate = String(req.headers[TOKEN_HEADER] || '');
        if (candidate.length !== token.length) return false;
        try { return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token)); }
        catch { return false; }
    }
    function send(res, code, body) {
        const data = Buffer.from(JSON.stringify(body));
        res.writeHead(code, {
            'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length,
            'Cache-Control': 'no-store'
        });
        res.end(data);
    }
    async function readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > 64 * 1024) { reject(new Error('Request body too large.')); req.destroy(); return; }
                chunks.push(chunk);
            });
            req.on('end', () => {
                try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
                catch { reject(new Error('Invalid JSON body.')); }
            });
            req.on('error', reject);
        });
    }

    let server;
    async function shutdown(code = 0) {
        if (runtime.closing) return;
        runtime.closing = true;
        runtime.state = 'stopping';
        try { server?.close(); } catch {}
        try { await context.close(); } catch {}
        process.exitCode = code;
        setTimeout(() => process.exit(code), 20).unref();
    }

    server = http.createServer(async (req, res) => {
        if (!authorized(req)) return send(res, 403, { ok: false, reason: 'Forbidden.' });
        const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        try {
            if (req.method === 'GET' && requestUrl.pathname === '/status') return send(res, 200, await status());
            if (req.method !== 'POST') return send(res, 404, { ok: false, reason: 'Not found.' });
            const body = await readBody(req);
            if (requestUrl.pathname === '/volume') return send(res, 200, await applyVolume(body));
            if (requestUrl.pathname === '/transport') return send(res, 200, await handleTransportWithActivation({
                page, spotifySnapshots, isSpotifyEmbedUrl, normalizeTrackId, note, runtime
            }, body));
            if (requestUrl.pathname === '/playlist') return send(res, 200, await importPlaylist(body));
            if (requestUrl.pathname === '/open') return send(res, 200, await openManagedPage(body));
            if (requestUrl.pathname === '/auth') return send(res, 200, await openAuth(body));
            if (requestUrl.pathname === '/shutdown') {
                send(res, 200, { ok: true, state: 'stopping' });
                setImmediate(() => shutdown(0));
                return;
            }
            return send(res, 404, { ok: false, reason: 'Not found.' });
        } catch (error) {
            runtime.lastError = String(error?.message || error).slice(0, 240);
            note('request-error', runtime.lastError);
            return send(res, 500, { ok: false, reason: runtime.lastError });
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    note('ready', `listening on 127.0.0.1:${port}`);
    process.on('SIGINT', () => shutdown(130));
    process.on('SIGTERM', () => shutdown(143));
    process.on('uncaughtException', (error) => {
        runtime.lastError = String(error?.stack || error).slice(0, 1000);
        note('uncaught', runtime.lastError);
        shutdown(1);
    });
}

module.exports = {
    SERVICE, PROTOCOL_VERSION, MAX_MEDIA_REFS, clampVolume, normalizeTrackId,
    validateLoopbackPageUrl, headlessRequestedFromPageUrl, isLikelyPlayControl,
    isSpotifyEmbedUrl, spotifyFrameTrackId, browserInit, parseArgs
};

if (require.main === module) {
    main().catch((error) => {
        console.error(`[${SERVICE}] ${error?.stack || error}`);
        process.exit(1);
    });
}
