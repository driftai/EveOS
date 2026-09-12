import https from 'node:https';
import http from 'node:http';
import { assertPublicHttpUrl } from './public-url.js';
import { json } from './http-utils.js';

export const ADDON_API_PATH_RE = /(?:^|\/)(?:manifest\.json|catalog\/|meta\/|stream\/|subtitles\/)/i;
const MAX_PROXY_BODY = 2 * 1024 * 1024;

export function addonProxyTimeoutMs(targetUrl) {
  let pathname = '';
  try { pathname = new URL(String(targetUrl || '')).pathname.toLowerCase(); } catch {}
  if (pathname.endsWith('/manifest.json') || pathname.endsWith('manifest.json')) return 4000;
  if (/(?:^|\/)meta\//i.test(pathname)) return 5000;
  if (/(?:^|\/)catalog\//i.test(pathname)) return 8000;
  if (/(?:^|\/)subtitles\//i.test(pathname)) return 8000;
  if (/(?:^|\/)stream\//i.test(pathname)) return 12000;
  return 10000;
}

export async function isAllowedAddonApiTarget(targetUrl) {
  try {
    const parsed = new URL(String(targetUrl || ''));
    if (parsed.protocol !== 'https:') return false;
    if (!ADDON_API_PATH_RE.test(parsed.pathname)) return false;
    await assertPublicHttpUrl(parsed.href);
    return true;
  } catch {
    return false;
  }
}

export async function handleNuvioAddonProxy(req, res, targetUrl, depth = 0) {
  if (depth > 3) {
    return json(res, 502, { error: 'too many redirects' });
  }

  const allowed = await isAllowedAddonApiTarget(targetUrl);
  if (!allowed) {
    return json(res, 403, { error: 'Addon API proxy target is not allowed' });
  }

  const parsed = new URL(targetUrl);
  const transport = parsed.protocol === 'http:' ? http : https;
  const clientReq = transport.request(parsed, {
    method: req.method === 'POST' ? 'POST' : 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Accept': req.headers['accept'] || 'application/json, */*',
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept-Encoding': 'identity'
    },
    timeout: addonProxyTimeoutMs(targetUrl)
  }, upstreamRes => {
    const statusCode = upstreamRes.statusCode || 500;

    if ([301, 302, 303, 307, 308].includes(statusCode) && upstreamRes.headers.location) {
      try {
        const nextUrl = new URL(upstreamRes.headers.location, parsed.href).href;
        upstreamRes.resume();
        return handleNuvioAddonProxy(req, res, nextUrl, depth + 1);
      } catch {
        return json(res, 502, { error: 'invalid redirect location' });
      }
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;

    upstreamRes.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_PROXY_BODY) chunks.push(chunk);
      else {
        tooLarge = true;
        upstreamRes.destroy(new Error('Addon API proxy response is too large'));
      }
    });

    upstreamRes.on('end', () => {
      if (res.headersSent || res.writableEnded) return;
      if (tooLarge) return json(res, 502, { error: 'Addon API proxy response is too large' });
      const payload = Buffer.concat(chunks);
      res.writeHead(statusCode, {
        'Content-Type': upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
        'Cross-Origin-Resource-Policy': 'same-origin'
      });
      res.end(payload);
    });

    upstreamRes.on('error', err => {
      if (!res.headersSent && !res.writableEnded) {
        json(res, 502, { error: tooLarge ? 'Addon API proxy response is too large' : `Addon API proxy stream error: ${err.message}` });
      }
    });
  });

  clientReq.on('timeout', () => {
    clientReq.destroy(new Error('Addon API proxy timeout'));
  });

  clientReq.on('error', err => {
    if (!res.headersSent && !res.writableEnded) {
      const timeout = /timeout/i.test(String(err?.message || ''));
      json(res, timeout ? 504 : 502, { error: timeout ? 'Addon API proxy timeout' : `Addon API proxy failed: ${err.message}` });
    }
  });

  if (req.method === 'POST') {
    req.pipe(clientReq);
  } else {
    clientReq.end();
  }
}
