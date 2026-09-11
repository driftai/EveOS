function hostnameFromHost(value) {
  const raw = String(value || '').split(',')[0].trim();
  if (!raw) return '';
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function socketIsLoopback(req) {
  const raw = String(req.socket?.remoteAddress || '').toLowerCase();
  return raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
}

export function isLocalHostName(value) {
  const hostname = String(value || '').toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '127-0-0-1.sslip.io';
}

export function requestHostIsLocal(req) {
  const direct = hostnameFromHost(req.headers?.host);
  if (!isLocalHostName(direct)) return false;
  const forwardedRaw = String(req.headers?.['x-forwarded-host'] || '').trim();
  if (forwardedRaw && !isLocalHostName(hostnameFromHost(forwardedRaw))) return false;
  return true;
}

export function browserOriginIsLocal(req, { allowNullOrigin = false } = {}) {
  const site = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (site === 'cross-site') return false;
  const origin = String(req.headers?.origin || '').trim();
  if (!origin) return true;
  if (origin === 'null') return allowNullOrigin;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && isLocalHostName(parsed.hostname);
  } catch {
    return false;
  }
}

export function isHostLocalRequest(req, options = {}) {
  if (!socketIsLoopback(req)) return false;
  if (!requestHostIsLocal(req)) return false;
  if (req.headers?.['cf-ray'] || req.headers?.['cf-connecting-ip']) return false;
  return browserOriginIsLocal(req, options);
}
