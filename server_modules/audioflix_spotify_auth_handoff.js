'use strict';

// The managed Spotify helper is the only reader of its authenticated browser context. This
// projection is returned solely over the helper's token-protected loopback API to the EveOS
// server; values must never be logged or returned to a browser client.
const AUTH_COOKIE_NAMES = new Set(['sp_dc', 'sp_key']);

function spotifyDomain(value) {
    const domain = String(value || '').trim().toLowerCase();
    return domain === '.spotify.com' || domain === 'spotify.com' || domain === 'open.spotify.com';
}

function project(cookie) {
    if (!cookie || !AUTH_COOKIE_NAMES.has(String(cookie.name || '').toLowerCase())) return null;
    if (!spotifyDomain(cookie.domain) || !cookie.value) return null;
    return {
        name: String(cookie.name), value: String(cookie.value), domain: String(cookie.domain),
        path: String(cookie.path || '/'), expires: Number(cookie.expires || 0),
        httpOnly: cookie.httpOnly === true, secure: cookie.secure !== false,
        sameSite: ['Lax', 'None', 'Strict'].includes(cookie.sameSite) ? cookie.sameSite : 'None'
    };
}

async function capture(context) {
    const cookies = (await context.cookies(['https://open.spotify.com', 'https://accounts.spotify.com']))
        .map(project).filter(Boolean);
    if (!cookies.length) return { ok: false, authState: 'unknown', reason: 'Managed Spotify session is not signed in.' };
    return { ok: true, version: 1, authState: 'signed-in', cookies };
}

module.exports = { AUTH_COOKIE_NAMES, spotifyDomain, project, capture };
