/** Stable YouTube identities that ignore share/tracking URL variations. */

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

function parsedUrl(value) {
  try { return new URL(String(value || '').trim()); } catch { return null; }
}

export function youtubeVideoId(value) {
  const url = parsedUrl(value);
  if (!url || !['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] || null;
  } else if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (/^\/(?:shorts|embed|live)\//.test(url.pathname)) {
      id = url.pathname.split('/').filter(Boolean)[1] || null;
    }
  }
  return VIDEO_ID.test(String(id || '')) ? String(id) : null;
}

export function canonicalYoutubeUrl(value) {
  const id = youtubeVideoId(value);
  return id ? `https://www.youtube.com/watch?v=${id}` : String(value || '').trim();
}

export function youtubeSourceIdentity(value, quality = '1080') {
  const id = youtubeVideoId(value);
  const source = id ? `video:${id}` : canonicalYoutubeUrl(value);
  return `youtube:${source}|quality:${String(quality || '1080').toLowerCase()}`;
}

export function canonicalMediaIdentity(value) {
  const identity = String(value || '');
  if (!identity.startsWith('youtube:')) return identity;
  const separator = identity.lastIndexOf('|quality:');
  const source = separator >= 0 ? identity.slice('youtube:'.length, separator) : identity.slice('youtube:'.length);
  const quality = separator >= 0 ? identity.slice(separator + '|quality:'.length) : '1080';
  if (source.startsWith('video:') && VIDEO_ID.test(source.slice('video:'.length))) {
    return `youtube:${source}|quality:${quality.toLowerCase()}`;
  }
  return youtubeSourceIdentity(source, quality);
}

export function youtubeUrlFromIdentity(value) {
  const canonical = canonicalMediaIdentity(value);
  const match = /^youtube:video:([A-Za-z0-9_-]{6,20})\|quality:/.exec(canonical);
  if (match) return `https://www.youtube.com/watch?v=${match[1]}`;
  const raw = String(value || '');
  const candidate = raw.startsWith('youtube:')
    ? raw.slice('youtube:'.length).split('|quality:')[0]
    : raw;
  return /^https?:\/\//i.test(candidate) ? canonicalYoutubeUrl(candidate) : null;
}
