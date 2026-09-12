import fs from 'node:fs';
import path from 'node:path';
import { NUVIO_DIST, PROJECT_ROOT } from './config.js';
import { assertPublicHttpUrl } from './public-url.js';

export const PUBLIC_ENV_KEYS = [
  'NUVIO_SUPABASE_URL',
  'NUVIO_SUPABASE_ANON_KEY',
  'TV_LOGIN_WEB_BASE_URL',
  'YOUTUBE_PROXY_URL',
  'INTRODB_API_URL',
  'AVATAR_PUBLIC_BASE_URL',
  'UNIQUE_CONTRIBUTIONS_BASE_URL',
  'SUPPORTERS_API_BASE_URL',
  'SUPPORT_URL',
  'SPONSOR_NAMES',
  'SIMKL_APP_NAME'
];

export const REQUIRED_NUVIO_DIST = [
  'index.html',
  'app.bundle.js',
  'core-js.bundle.js',
  'nuvio.env.js'
];

let discoveryCache = { at: 0, data: {} };
const DISCOVERY_TTL = 300 * 1000;

export async function discoverBackend(url) {
  const rawBase = String(url || '').trim().replace(/\/+$/, '');
  if (!rawBase) return {};
  let base;
  try {
    base = (await assertPublicHttpUrl(rawBase)).replace(/\/+$/, '');
  } catch {
    return {};
  }
  const nowMs = Date.now();
  if (discoveryCache.data[base] && (nowMs - discoveryCache.at) < DISCOVERY_TTL) {
    return discoveryCache.data[base];
  }
  try {
    const res = await fetch(`${base}/.well-known/nuvio`, {
      headers: { 'User-Agent': 'WatchFusion/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return {};
    const data = await res.json();
    if (data && typeof data === 'object') {
      discoveryCache = { at: nowMs, data: { ...discoveryCache.data, [base]: data } };
      return data;
    }
  } catch {}
  return {};
}

export function parsePropertiesFile(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const match = line.match(/^["']?([A-Z][A-Z0-9_]*)["']?\s*[:=]\s*["']?([^"',;\r\n}]*)["']?\s*[,;]?$/);
    if (match) values[match[1]] = match[2].trim();
  }
  for (const key of PUBLIC_ENV_KEYS) {
    if (values[key] !== undefined) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`["']?${escaped}["']?\\s*[:=]\\s*["']([^"']*)["']`));
    if (match) values[key] = match[1].trim();
  }
  return values;
}

export function hardenNuvioYoutubeProxyHtml(html) {
  return String(html || '')
    .replace(
      'var pageOrigin = String((location && location.origin) || "").trim();',
      'var pageOrigin = "https://nuvio.tv";'
    )
    .replace(
      'var widgetReferrer = pageOriginIsHttp ? location.href : "https://www.youtube.com";',
      'var widgetReferrer = "https://nuvio.tv/";'
    )
    .replace('var autoplay = params.autoplay !== "0";', 'var autoplay = false;')
    .replace(/\s*if \(autoplay\) \{\s*event\.target\.playVideo\(\);\s*\}/, '')
    .replace('}, 4500);', '}, 2500);');
}

export function isNuvioBuilt(distPath = NUVIO_DIST) {
  return REQUIRED_NUVIO_DIST.every(file => fs.existsSync(path.join(distPath, file)));
}

export async function mergedNuvioConfig(distPath = NUVIO_DIST) {
  const buildEnv = parsePropertiesFile(path.join(distPath, 'nuvio.env.js'));
  const wrapperProps = parsePropertiesFile(path.join(PROJECT_ROOT, 'nuvio-wrapper.properties'));
  const localProps = parsePropertiesFile(path.join(PROJECT_ROOT, 'local.properties'));

  const merged = { ...buildEnv, ...wrapperProps, ...localProps };
  const backendUrl = merged.NUVIO_SUPABASE_URL || 'https://api.nuvio.tv';
  const discovery = await discoverBackend(backendUrl);

  const keySource = merged.NUVIO_SUPABASE_ANON_KEY ? 'manual' : (discovery.publishable_key ? 'discovery' : 'none');
  const publishableKey = merged.NUVIO_SUPABASE_ANON_KEY || discovery.publishable_key || '';

  return {
    merged: {
      ...merged,
      NUVIO_SUPABASE_URL: backendUrl,
      NUVIO_SUPABASE_ANON_KEY: publishableKey,
      TV_LOGIN_WEB_BASE_URL: merged.TV_LOGIN_WEB_BASE_URL || 'https://nuvio.tv/tv-login',
      YOUTUBE_PROXY_URL: merged.YOUTUBE_PROXY_URL || 'youtube-proxy.html'
    },
    keySource,
    discovery
  };
}

let cachedHlsJs = '';
function getHlsJsBundle() {
  if (cachedHlsJs) return cachedHlsJs;
  const hlsPath = path.join(PROJECT_ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
  if (fs.existsSync(hlsPath)) {
    try {
      cachedHlsJs = fs.readFileSync(hlsPath, 'utf8');
    } catch (_) {}
  }
  return cachedHlsJs;
}

export async function generateNuvioEnvScript(distPath = NUVIO_DIST) {
  const { merged } = await mergedNuvioConfig(distPath);
  const safeEnv = {};
  for (const key of PUBLIC_ENV_KEYS) {
    if (merged[key] !== undefined) safeEnv[key] = merged[key];
  }
  safeEnv.YOUTUBE_PROXY_URL = '/__nuvio__/youtube-proxy.html';
  const hlsJs = getHlsJsBundle();

  return `window.__NUVIO_ENV__ = ${JSON.stringify(safeEnv)};
${hlsJs ? `\n${hlsJs}\n` : ''}
(function() {
  var origFetch = window.fetch;
  var nuvioHost = String((window.location && window.location.hostname) || '').toLowerCase();
  var watchFusionHostLocal = nuvioHost === '127.0.0.1' || nuvioHost === 'localhost' || nuvioHost === '::1';
  var addonPathRe = /(?:^|\\/)(?:manifest\\.json|catalog\\/|meta\\/|stream\\/|subtitles\\/)/i;
  var mediaPathRe = /(?:\\.(?:m3u8|mpd|mp4|m4v|mov|mkv|webm|ts|m2ts|m4s|mp3|aac|flac|urlset)(?:$|[?#])|\\/(?:hls|hls2)(?:\\/|$|[?#])|[?&](?:format|type|mime|output)=(?:m3u8|hls|mpd|dash)(?:&|$))/i;

  window.__NUVIO_ALLOW_BROWSER_PLUGIN_RUNTIME__ = watchFusionHostLocal;
  if (watchFusionHostLocal && origFetch) {
    window.__WATCHFUSION_NUVIO_PLUGIN_FETCH__ = async function(request) {
      var target = request && request.url ? String(request.url) : '';
      if (!target) throw new Error('Plugin target URL is required');
      var payload = {
        url: target,
        method: String((request && request.method) || 'GET'),
        headers: (request && request.headers) || {},
        body: (request && request.body) || '',
        timeoutMs: Number((request && request.timeoutMs) || 15000),
        maxResponseBytes: Number((request && request.maxResponseBytes) || 1048576)
      };
      var proxyResponse = await origFetch('/__nuvio__/plugin-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': '*/*' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        signal: request && request.signal ? request.signal : undefined
      });
      var responseHeaders = {};
      try {
        proxyResponse.headers.forEach(function(value, key) { responseHeaders[key] = value; });
      } catch (_) {}
      return {
        returnValue: true,
        ok: proxyResponse.ok,
        status: proxyResponse.status,
        statusText: proxyResponse.statusText,
        url: proxyResponse.headers.get('X-WatchFusion-Upstream-Url') || target,
        body: await proxyResponse.text(),
        headers: responseHeaders,
        truncated: false
      };
    };
  } else {
    try { delete window.__WATCHFUSION_NUVIO_PLUGIN_FETCH__; } catch (_) {}
  }

  function getProxyUrl(urlStr) {
    try {
      var parsed = new URL(urlStr, window.location.href);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        if (parsed.origin !== window.location.origin) {
          var mediaCandidate = parsed.pathname + parsed.search;
          if (mediaPathRe.test(mediaCandidate) || mediaPathRe.test(parsed.href)) {
            return '/api/media/stream?url=' + encodeURIComponent(parsed.href);
          }
          if (addonPathRe.test(parsed.pathname)) {
            return '/__nuvio__/addon-proxy?url=' + encodeURIComponent(parsed.href);
          }
        }
      }
    } catch (_) {}
    return null;
  }

  function proxyMediaUrl(value) {
    var proxyUrl = getProxyUrl(value);
    return proxyUrl || value;
  }

  try {
    var rawSetItem = window.localStorage && window.localStorage.setItem.bind(window.localStorage);
    if (rawSetItem && !window.__watchFusionNuvioStoragePatched) {
      var disableTrailerAutoplay = function(value) {
        try {
          var parsed = JSON.parse(String(value));
          if (parsed && parsed.__profileScoped === true && parsed.profiles && typeof parsed.profiles === 'object') {
            Object.keys(parsed.profiles).forEach(function(id) {
              if (parsed.profiles[id] && typeof parsed.profiles[id] === 'object') parsed.profiles[id].trailerAutoplay = false;
            });
          } else if (parsed && typeof parsed === 'object') {
            parsed.trailerAutoplay = false;
          }
          return JSON.stringify(parsed);
        } catch (_) { return value; }
      };
      window.localStorage.setItem = function(key, value) {
        if (String(key || '') === 'playerSettings') value = disableTrailerAutoplay(value);
        return rawSetItem(String(key), value);
      };
      var currentSettings = window.localStorage.getItem('playerSettings');
      if (currentSettings != null) rawSetItem('playerSettings', disableTrailerAutoplay(currentSettings));
      window.__watchFusionNuvioStoragePatched = true;
    }
  } catch (_) {}

  if (origFetch) {
    window.fetch = function(input, init) {
      var urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      var proxyUrl = getProxyUrl(urlStr);
      if (proxyUrl) {
        if (typeof input === 'string') {
          return origFetch.call(this, proxyUrl, init);
        }
        var nextInit = Object.assign({}, init);
        return origFetch.call(this, new Request(proxyUrl, input), nextInit);
      }
      return origFetch.apply(this, arguments);
    };
  }

  if (typeof window !== 'undefined' && window.XMLHttpRequest) {
    var origOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function(method, url) {
      var proxyUrl = getProxyUrl(url);
      var target = proxyUrl || url;
      var args = Array.prototype.slice.call(arguments);
      args[1] = target;
      return origOpen.apply(this, args);
    };
  }

  try {
    var mediaProto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    var srcDescriptor = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, 'src');
    if (
      mediaProto &&
      srcDescriptor &&
      typeof srcDescriptor.get === 'function' &&
      typeof srcDescriptor.set === 'function' &&
      !window.__watchFusionNuvioMediaSrcPatched
    ) {
      Object.defineProperty(mediaProto, 'src', {
        configurable: srcDescriptor.configurable,
        enumerable: srcDescriptor.enumerable,
        get: srcDescriptor.get,
        set: function(value) {
          return srcDescriptor.set.call(this, proxyMediaUrl(value));
        }
      });
      var rawMediaSetAttribute = mediaProto.setAttribute;
      mediaProto.setAttribute = function(name, value) {
        if (String(name || '').toLowerCase() === 'src') value = proxyMediaUrl(value);
        return rawMediaSetAttribute.call(this, name, value);
      };
      window.__watchFusionNuvioMediaSrcPatched = true;
    }
  } catch (_) {}
})();
`;
}
