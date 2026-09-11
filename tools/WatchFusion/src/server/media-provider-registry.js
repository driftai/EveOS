import { directMediaProvider } from './direct-media-provider.js';
import { nuvioMediaProvider } from './nuvio-media-provider.js';
import { parseYoutubeUrl, youtubeUrlFromId } from './youtube.js';

const providers = new Map();

export function registerMediaProvider(provider) {
  if (!provider?.id || typeof provider.supports !== 'function' || typeof provider.resolve !== 'function') {
    throw new TypeError('Media provider requires id, supports(), and resolve().');
  }
  providers.set(String(provider.id), Object.freeze(provider));
  return provider;
}

export function findMediaProvider(input) {
  return [...providers.values()].find(provider => provider.supports(input)) || null;
}

export function listMediaProviders() {
  return [...providers.values()].map(provider => provider.id);
}

// 1. Direct media provider (MP4, WEBM, MKV, HLS)
registerMediaProvider(directMediaProvider);

// 2. YouTube provider
registerMediaProvider({
  id: 'youtube',
  name: 'YouTube Provider',
  supports: input => {
    if (typeof input === 'object') return input?.kind === 'youtube' || input?.type === 'youtube';
    return Boolean(parseYoutubeUrl(input));
  },
  resolve: async input => {
    const videoId = typeof input === 'object' ? input.videoId : parseYoutubeUrl(input);
    if (!videoId) return { ok: false, error: 'Invalid YouTube URL or ID' };
    const originalUrl = typeof input === 'object' ? (input.originalUrl || youtubeUrlFromId(videoId)) : youtubeUrlFromId(videoId);
    return {
      ok: true,
      pageUrl: originalUrl,
      title: `YouTube: ${videoId}`,
      audio: null,
      provider: 'youtube',
      results: [{
        url: youtubeUrlFromId(videoId),
        videoId,
        type: 'youtube',
        quality: null,
        server: 'youtube.com',
        provider: 'youtube',
        label: 'YOUTUBE',
        title: `YouTube: ${videoId}`,
        audio: null,
        subtitles: []
      }],
      message: 'YouTube video accepted.'
    };
  }
});

// 3. Nuvio media provider (WebOS integration, Stremio catalogs)
registerMediaProvider(nuvioMediaProvider);

// 4. External watch-page resolver (Browser-based extractor)
registerMediaProvider({
  id: 'browser-page',
  name: 'Watch Page Extractor',
  supports: input => {
    const value = typeof input === 'string' ? String(input).trim() : '';
    return /^https?:\/\//i.test(value) && !directMediaProvider.supports(value) && !parseYoutubeUrl(value);
  },
  resolve: (input, options) => import('./media-resolver.js').then(module => module.resolveMediaPage(input, options))
});
