import { classifyMediaUrl } from './media-resolver.js';

export const directMediaProvider = Object.freeze({
  id: 'direct-media',
  supports: input => {
    const parsed = classifyMediaUrl(input);
    return !!parsed && parsed.kind !== 'page';
  },
  resolve: async input => {
    const parsed = classifyMediaUrl(input);
    if (!parsed || parsed.kind === 'page') return { ok: false, code: 'NOT_DIRECT_MEDIA', message: 'The supplied URL is not a direct media resource.' };
    return {
      ok: true,
      pageUrl: parsed.url,
      title: null,
      audio: null,
      results: [{ url: parsed.url, type: parsed.kind, quality: null, server: new URL(parsed.url).hostname, title: null, audio: null, subtitles: [], referer: null }],
      message: 'Direct media URL accepted without page discovery.'
    };
  }
});
