import http from 'node:http';
import https from 'node:https';
import { assertPublicHttpUrl } from './public-url.js';
import { json } from './http-utils.js';

const MAX_ENVELOPE_BYTES = 1200 * 1024;
const MAX_PLUGIN_BODY_BYTES = 1024 * 1024;
const MAX_PLUGIN_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_TIMEOUT_MS = 20000;
const DEFAULT_TIMEOUT_MS = 15000;
const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

async function readEnvelope(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_ENVELOPE_BYTES) throw new Error('Plugin request envelope is too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Plugin request envelope must be an object');
  }
  return parsed;
}

function normalizedMethod(value) {
  const method = String(value || 'GET').trim().toUpperCase();
  return ['GET', 'POST', 'PUT', 'DELETE'].includes(method) ? method : 'GET';
}

function normalizedTimeout(value) {
  const timeout = Number(value || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.trunc(timeout)));
}

function normalizedResponseLimit(value) {
  const limit = Number(value || MAX_PLUGIN_RESPONSE_BYTES);
  if (!Number.isFinite(limit) || limit <= 0) return MAX_PLUGIN_RESPONSE_BYTES;
  return Math.max(1024, Math.min(MAX_PLUGIN_RESPONSE_BYTES, Math.trunc(limit)));
}

function normalizedHeaders(input) {
  const headers = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return headers;
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = String(rawName || '').trim();
    const lower = name.toLowerCase();
    if (!name || HOP_BY_HOP_HEADERS.has(lower) || rawValue == null) continue;
    const value = String(rawValue);
    if (value.length > 8192) continue;
    headers[name] = value;
  }
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  }
  headers['Accept-Encoding'] = 'identity';
  return headers;
}

function redirectedRequest(statusCode, method, body) {
  if (statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST')) {
    return { method: 'GET', body: null };
  }
  return { method, body };
}

async function proxyPluginRequest(req, res, request, depth = 0) {
  if (depth > MAX_REDIRECTS) return json(res, 502, { error: 'too many plugin fetch redirects' });

  const publicUrl = await assertPublicHttpUrl(request.url);
  const parsed = new URL(publicUrl);
  const method = normalizedMethod(request.method);
  const headers = normalizedHeaders(request.headers);
  const timeoutMs = normalizedTimeout(request.timeoutMs);
  const responseLimit = normalizedResponseLimit(request.maxResponseBytes);
  let body = ['POST', 'PUT'].includes(method) ? Buffer.from(String(request.body || ''), 'utf8') : null;
  if (body && body.length > MAX_PLUGIN_BODY_BYTES) {
    return json(res, 413, { error: 'plugin request body exceeds the 1 MiB quota' });
  }
  if (body) headers['Content-Length'] = String(body.length);

  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };

    const upstream = transport.request(parsed, { method, headers, timeout: timeoutMs }, upstreamRes => {
      const statusCode = Number(upstreamRes.statusCode || 502);
      if ([301, 302, 303, 307, 308].includes(statusCode) && upstreamRes.headers.location) {
        let nextUrl;
        try {
          nextUrl = new URL(upstreamRes.headers.location, publicUrl).href;
        } catch {
          upstreamRes.resume();
          json(res, 502, { error: 'invalid plugin fetch redirect' });
          return finish();
        }
        upstreamRes.resume();
        const next = redirectedRequest(statusCode, method, body);
        proxyPluginRequest(req, res, {
          ...request,
          url: nextUrl,
          method: next.method,
          body: next.body ? next.body.toString('utf8') : ''
        }, depth + 1).then(finish, error => {
          if (!res.headersSent) json(res, 502, { error: `plugin redirect failed: ${error.message}` });
          finish();
        });
        return;
      }

      const chunks = [];
      let size = 0;
      let tooLarge = false;
      upstreamRes.on('data', chunk => {
        size += chunk.length;
        if (size <= responseLimit) chunks.push(chunk);
        else {
          tooLarge = true;
          upstreamRes.destroy(new Error('plugin response quota exceeded'));
        }
      });
      upstreamRes.on('end', () => {
        if (res.headersSent || res.writableEnded) return finish();
        if (tooLarge) {
          json(res, 502, { error: 'plugin response exceeds the configured quota' });
          return finish();
        }
        const payload = Buffer.concat(chunks);
        res.writeHead(statusCode, {
          'Content-Type': upstreamRes.headers['content-type'] || 'text/plain; charset=utf-8',
          'Content-Length': payload.length,
          'Cache-Control': 'no-store',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-WatchFusion-Upstream-Url': publicUrl
        });
        res.end(payload);
        finish();
      });
      upstreamRes.on('error', error => {
        if (!res.headersSent && !res.writableEnded) {
          json(res, tooLarge ? 502 : 502, {
            error: tooLarge ? 'plugin response exceeds the configured quota' : `plugin upstream stream failed: ${error.message}`
          });
        }
        finish();
      });
    });

    const abortUpstream = () => {
      if (!upstream.destroyed) upstream.destroy();
    };
    req.once('aborted', abortUpstream);

    upstream.on('timeout', () => {
      upstream.destroy(new Error('plugin fetch timeout'));
    });
    upstream.on('error', error => {
      if (!res.headersSent && !res.writableEnded) {
        const timeout = /timeout/i.test(String(error?.message || ''));
        json(res, timeout ? 504 : 502, { error: timeout ? 'plugin fetch timeout' : `plugin fetch failed: ${error.message}` });
      }
      finish();
    });

    if (body) upstream.end(body);
    else upstream.end();
  });
}

export async function handleNuvioPluginFetch(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  let request;
  try {
    request = await readEnvelope(req);
  } catch (error) {
    return json(res, /too large/i.test(error.message) ? 413 : 400, { error: error.message });
  }
  if (!request.url) return json(res, 400, { error: 'plugin target url is required' });
  try {
    await proxyPluginRequest(req, res, request);
  } catch (error) {
    if (!res.headersSent && !res.writableEnded) {
      return json(res, 400, { error: error.message });
    }
  }
  return true;
}
