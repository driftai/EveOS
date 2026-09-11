import { isNuvioBuilt } from './nuvio-config.js';
import { NUVIO_DIST } from './config.js';

export const nuvioMediaProvider = {
  id: 'nuvio',
  name: 'Nuvio Media Integration',
  supports(input) {
    if (!input) return false;
    if (typeof input === 'object') {
      return input.kind === 'nuvio' || input.type === 'nuvio';
    }
    const str = String(input).trim().toLowerCase();
    return str.startsWith('nuvio://') || str.startsWith('stremio://') || /^tt\d{7,10}$/i.test(str);
  },
  async resolve(input, options = {}) {
    const isBuilt = isNuvioBuilt(NUVIO_DIST);
    const identifier = typeof input === 'object' ? (input.url || input.id || 'nuvio-entry') : String(input).trim();
    const title = (typeof input === 'object' && input.title) ? input.title : `Nuvio: ${identifier}`;

    return {
      ok: true,
      pageUrl: typeof input === 'object' ? input.originalUrl || 'nuvio://' : identifier,
      title,
      audio: null,
      provider: 'nuvio',
      results: [{
        url: identifier,
        type: 'nuvio',
        quality: null,
        server: 'nuvio',
        provider: 'nuvio',
        label: 'NUVIO',
        title,
        audio: null,
        subtitles: [],
        entryUrl: '/nuvio/dist/index.html',
        isBuilt
      }],
      message: isBuilt
        ? 'Nuvio media integration loaded successfully.'
        : 'Nuvio integration selected. Note: Nuvio browser build is not yet installed in .\\nuvio\\dist.'
    };
  }
};
