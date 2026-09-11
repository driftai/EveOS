export function parseYoutubeUrl(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let videoId = '';

  if (hostname === 'youtu.be') videoId = parts[0] || '';
  else if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v') || '';
    if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) videoId = parts[1] || '';
  }

  return /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? videoId : null;
}

export const youtubeUrlFromId = videoId =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
