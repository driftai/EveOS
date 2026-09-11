import https from 'node:https';
import http from 'node:http';
import { assertPublicHttpUrl } from './public-url.js';
import { json } from './http-utils.js';

export const ADDON_API_PATH_RE = /(?:^|\/)(?:manifest\.json|catalog\/|meta\/|stream\/|subtitles\/)/i;
const MAX_PROXY_BODY = 2 * 1024 * 1024;

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
      'Content-Type': req.headers['content-type'] || 'application/json'
    },
    timeout: 15000
  }, upstreamRes => {
    const statusCode = upstreamRes.statusCode || 500;

    // Handle Redirects safely
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

    upstreamRes.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_PROXY_BODY) chunks.push(chunk);
      else upstreamRes.destroy();
    });

    upstreamRes.on('end', () => {
      if (res.headersSent || res.writableEnded) return;
      const payload = Buffer.concat(chunks);
      res.writeHead(statusCode, {
        'Content-Type': upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept'
      });
      res.end(payload);
    });

    upstreamRes.on('error', err => {
      if (!res.headersSent && !res.writableEnded) {
        json(res, 502, { error: `Addon API proxy stream error: ${err.message}` });
      }
    });
  });

  clientReq.on('timeout', () => {
    clientReq.destroy();
    if (!res.headersSent && !res.writableEnded) {
      json(res, 504, { error: 'Addon API proxy timeout' });
    }
  });

  clientReq.on('error', err => {
    if (!res.headersSent && !res.writableEnded) {
      json(res, 502, { error: `Addon API proxy failed: ${err.message}` });
    }
  });

  if (req.method === 'POST') {
    req.pipe(clientReq);
  } else {
    clientReq.end();
  }
}
