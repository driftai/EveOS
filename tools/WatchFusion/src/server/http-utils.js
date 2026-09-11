export function now() {
  return Date.now();
}

export function isApiRequest(req) {
  const url = String(req.url || '');
  return url.startsWith('/api/') || url.startsWith('/__nuvio__/') || url.startsWith('/__wrapper__/');
}

function firstForwardedHost(value) {
  return String(value || '').split(',')[0].trim();
}

function hostnameFromHostHeader(value) {
  const host = firstForwardedHost(value);
  if (!host) return '';
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function parsedBrowserOrigin(req) {
  const raw = String(req.headers?.origin || '').trim();
  if (!raw || raw === 'null') return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isTrustedApiBrowserOrigin(req) {
  const origin = parsedBrowserOrigin(req);
  if (!origin) return false;
  const requestHostnames = [
    hostnameFromHostHeader(req.headers?.host),
    hostnameFromHostHeader(req.headers?.['x-forwarded-host'])
  ].filter(Boolean);
  return requestHostnames.includes(origin.hostname.toLowerCase());
}

export function apiCorsOriginForRequest(req) {
  if (!isApiRequest(req)) return null;
  const rawOrigin = String(req.headers?.origin || '').trim();
  if (!rawOrigin) return null;

  // EveOS file:// mode uses a null origin only for the read-only WatchFusion
  // health probe. Keep that probe working without granting null-origin access
  // to setup, room, proxy, or machine-diagnostic APIs.
  const pathname = String(req.url || '').split('?')[0];
  if (rawOrigin === 'null') return pathname === '/api/health' ? 'null' : null;

  return isTrustedApiBrowserOrigin(req) ? rawOrigin : null;
}

export function applyApiCors(req, res) {
  if (!isApiRequest(req)) return;
  const allowedOrigin = apiCorsOriginForRequest(req);
  if (!allowedOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Member-Id, Accept');
  res.setHeader('Access-Control-Max-Age', '600');
  if (String(req.headers?.['access-control-request-private-network'] || '').toLowerCase() === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

export function json(res, code, body) {
  if (!res || res.headersSent || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

export async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256 * 1024) throw new Error('payload too large');
  }
  return body ? JSON.parse(body) : {};
}
