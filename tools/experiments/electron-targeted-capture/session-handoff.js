'use strict';

const AUTH_NAMES = new Set(['sp_dc', 'sp_key']);

function normalize(cookie) {
  const name = String(cookie?.name || '').toLowerCase();
  const domain = String(cookie?.domain || '').toLowerCase();
  if (!AUTH_NAMES.has(name) || !['.spotify.com', 'spotify.com', 'open.spotify.com'].includes(domain)
      || typeof cookie?.value !== 'string' || !cookie.value) return null;
  const path = String(cookie.path || '/').startsWith('/') ? String(cookie.path || '/') : '/';
  const sameSite = { Lax: 'lax', None: 'no_restriction', Strict: 'strict' }[cookie.sameSite] || 'no_restriction';
  const out = { url: `https://open.spotify.com${path}`, name, value: cookie.value, domain, path,
    secure: true, httpOnly: cookie.httpOnly === true, sameSite };
  if (Number(cookie.expires) > Date.now() / 1000) out.expirationDate = Number(cookie.expires);
  return out;
}

async function apply(targetSession, options = {}) {
  if (!options.enabled) return { applied: false, count: 0 };
  const envelope = options.envelope;
  if (Number(envelope?.version) !== 1 || !Array.isArray(envelope?.cookies)) {
    throw new Error('Spotify session handoff version is invalid.');
  }
  const cookies = envelope.cookies.map(normalize).filter(Boolean);
  if (!cookies.length) throw new Error('Spotify session handoff contains no permitted authentication cookies.');
  for (const cookie of cookies) await targetSession.cookies.set(cookie);
  const installed = await targetSession.cookies.get({ url: 'https://open.spotify.com' });
  const count = installed.filter((cookie) => AUTH_NAMES.has(String(cookie.name || '').toLowerCase())).length;
  if (!count) throw new Error('Spotify authentication cookies were not installed.');
  return { applied: true, count };
}

module.exports = { AUTH_NAMES, normalize, apply };
