import http from 'node:http';
import https from 'node:https';
import { json, readBody } from './http-utils.js';
import { getMember, getRoom, hasRoom, resolveRoomId } from './room-store.js';
import { classifyMediaUrl } from './media-resolver.js';
import { findMediaProvider } from './media-provider-registry.js';
import { assertPublicHttpUrl } from './public-url.js';

const activeResolutions = new Set();

function buildMediaProxyPath(rawUrl, baseUrl, referer) {
  try {
    const resolved = new URL(String(rawUrl || '').trim(), baseUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) return rawUrl;
    return '/api/media/stream?url=' + encodeURIComponent(resolved.href)
      + (referer ? '&referer=' + encodeURIComponent(referer) : '');
  } catch {
    return rawUrl;
  }
}

export function rewriteM3u8(content, baseUrl, referer) {
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (!trimmed.startsWith('#')) {
      return buildMediaProxyPath(trimmed, baseUrl, referer);
    }

    // HLS can hide additional network dependencies in tag attributes rather
    // than on ordinary URI lines. Keep keys, init maps, alternate renditions,
    // and iframe playlists on the same guarded media proxy as segments.
    return line.replace(/\bURI=(["'])([^"']+)\1/gi, (match, quote, rawUri) => {
      const proxied = buildMediaProxyPath(rawUri, baseUrl, referer);
      return `URI=${quote}${proxied}${quote}`;
    });
  }).join('\n');
}

async function streamMediaUrl(req, res, targetUrl, referer, depth = 0) {
  if (depth > 5) {
    if (!res.headersSent) json(res, 508, { error: 'Too many stream redirects' });
    return true;
  }
  const publicUrl = await assertPublicHttpUrl(targetUrl);
  let upstreamReferer = String(referer || '').trim();
  if (!upstreamReferer || upstreamReferer.includes('.watami.win') || upstreamReferer.includes('.piltover.li') || upstreamReferer.includes('.m3u8')) {
    upstreamReferer = 'https://www.miruro.ru/';
  }
  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': req.headers['accept'] || '*/*',
    'Referer': upstreamReferer
  };
  if (req.headers['range']) upstreamHeaders['Range'] = req.headers['range'];
  if (req.headers['authorization']) upstreamHeaders['Authorization'] = req.headers['authorization'];
  if (req.headers['accept-language']) upstreamHeaders['Accept-Language'] = req.headers['accept-language'];

  const parsedUrl = new URL(publicUrl);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const proxyReq = client.get(publicUrl, { headers: upstreamHeaders, timeout: 25000 }, proxyRes => {
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        try {
          const nextUrl = new URL(proxyRes.headers.location, publicUrl).href;
          if (nextUrl.includes('cujo.io') || nextUrl.includes('warn.html') || nextUrl.includes('block.') || nextUrl.includes('blocked.')) {
            if (!res.headersSent) json(res, 502, { error: 'Stream blocked by ISP/network security filter: ' + nextUrl });
            resolve(true);
            return;
          }
          return streamMediaUrl(req, res, nextUrl, referer, depth + 1).then(resolve);
        } catch (_) {}
      }

      const contentType = proxyRes.headers['content-type'] || '';
      const isM3u8 = contentType.includes('mpegurl') || publicUrl.toLowerCase().includes('.m3u8');
      const responseHeaders = {
        'Cache-Control': 'no-cache',
        'Cross-Origin-Resource-Policy': 'same-origin'
      };
      if (proxyRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
      if (proxyRes.headers['content-range']) responseHeaders['Content-Range'] = proxyRes.headers['content-range'];

      if (isM3u8) {
        let data = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          const trimmed = data.trim();
          if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.includes('<title>Blocked') || trimmed.includes('cujo.io')) {
            if (!res.headersSent) json(res, 502, { error: 'Upstream stream returned HTML block page instead of M3U8 manifest' });
            resolve(true);
            return;
          }
          responseHeaders['Content-Type'] = 'application/vnd.apple.mpegurl';
          const rewritten = rewriteM3u8(data, publicUrl, referer);
          res.writeHead(proxyRes.statusCode || 200, responseHeaders);
          res.end(rewritten);
          resolve(true);
        });
      } else {
        responseHeaders['Content-Type'] = contentType || (publicUrl.endsWith('.ts') ? 'video/MP2T' : 'application/octet-stream');
        if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
        res.writeHead(proxyRes.statusCode || 200, responseHeaders);
        proxyRes.pipe(res);
        proxyRes.on('end', () => resolve(true));
      }
    });

    proxyReq.on('error', err => {
      if (parsedUrl.protocol === 'https:' && depth === 0) {
        const isSslErr = (err.code === 'ERR_SSL_PACKET_LENGTH_TOO_LONG' || String(err.message || '').includes('SSL') || String(err.message || '').includes('packet length'));
        if (isSslErr) {
          const httpUrl = publicUrl.replace(/^https:/i, 'http:');
          return streamMediaUrl(req, res, httpUrl, referer, depth + 1).then(resolve);
        }
      }
      if (!res.headersSent) json(res, 502, { error: 'Upstream media fetch failed: ' + err.message });
      resolve(true);
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) json(res, 504, { error: 'Upstream media fetch timed out.' });
      resolve(true);
    });
  });
}

function directMediaResult(parsed, originalUrl) {
  return {
    ok: true,
    pageUrl: originalUrl,
    title: null,
    audio: null,
    provider: 'direct-media',
    results: [{
      url: parsed.url,
      type: parsed.kind,
      quality: null,
      server: new URL(parsed.url).hostname,
      provider: 'direct-media',
      label: parsed.kind.toUpperCase(),
      title: null,
      audio: null,
      subtitles: [],
      referer: originalUrl
    }],
    message: 'Direct playable media URL accepted without page discovery.'
  };
}

export async function handleMediaRoute(req, res, parts) {
  if (parts[0] !== 'api' || parts[1] !== 'media') return false;

  if (req.method === 'GET' && parts[2] === 'stream') {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const targetUrl = reqUrl.searchParams.get('url');
    const referer = reqUrl.searchParams.get('referer');
    if (!targetUrl) return json(res, 400, { error: 'url parameter required' });
    try {
      await streamMediaUrl(req, res, targetUrl, referer);
      return true;
    } catch (error) {
      if (!res.headersSent) return json(res, 400, { error: error.message });
      return true;
    }
  }

  if (req.method === 'POST' && parts[2] === 'resolve') {
    const memberId = String(req.headers['x-member-id'] || '');
    try {
      const body = await readBody(req);
      const requestedRoomId = body.roomId ? resolveRoomId(body.roomId) : null;
      if (body.roomId && (!requestedRoomId || !hasRoom(requestedRoomId))) {
        return json(res, 404, { ok: false, code: 'ROOM_NOT_FOUND', message: 'Room not found.' });
      }
      if (requestedRoomId) {
        const room = getRoom(requestedRoomId);
        const member = getMember(room, memberId);
        if (!member || member.id !== room.hostId) {
          return json(res, 403, { ok: false, code: 'HOST_REQUIRED', message: 'Only the current host can resolve external media for this room.' });
        }
      }

      const parsed = classifyMediaUrl(body.url);
      if (!parsed) throw new Error('Only valid public http(s) URLs are supported.');
      const publicUrl = await assertPublicHttpUrl(parsed.url);
      const validated = { ...parsed, url: publicUrl };
      if (validated.kind === 'hls' || validated.kind === 'file') return json(res, 200, directMediaResult(validated, body.url));

      const provider = findMediaProvider(validated.url);
      if (!provider) return json(res, 422, { ok: false, code: 'NO_MEDIA_PROVIDER', message: 'No media resolver supports this URL.' });

      const key = requestedRoomId ? `${requestedRoomId}:${memberId}` : `solo:${memberId || 'anonymous'}`;
      if (activeResolutions.has(key)) return json(res, 429, { ok: false, code: 'RESOLUTION_IN_PROGRESS', message: 'A media resolution is already running for this room.' });
      activeResolutions.add(key);
      try {
        const result = await provider.resolve(validated.url, { timeoutMs: body.timeoutMs, maxResults: 12 });
        return json(res, result.ok ? 200 : 422, { ...result, provider: provider.id });
      } finally {
        activeResolutions.delete(key);
      }
    } catch (error) {
      return json(res, 400, { ok: false, code: 'RESOLVE_FAILED', message: error.message });
    }
  }

  return json(res, 404, { error: 'not found' });
}
