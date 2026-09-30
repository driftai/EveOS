import os from 'node:os';

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

function normalizedAddress(value) {
  return String(value || '').toLowerCase().replace(/^::ffff:/, '');
}
function hostMachineAddresses() {
  const out = new Set(['127.0.0.1', '::1']);
  try {
    for (const entries of Object.values(os.networkInterfaces() || {})) {
      for (const entry of entries || []) if (entry?.address) out.add(normalizedAddress(entry.address));
    }
  } catch {}
  return out;
}
function sslipIpv4(value) {
  const match = String(value || '').toLowerCase().match(/^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io$/);
  return match ? match.slice(1).join('.') : '';
}
export function socketIsHostMachine(req) {
  const raw = normalizedAddress(req.socket?.remoteAddress);
  return socketIsLoopback(req) || (!!raw && hostMachineAddresses().has(raw));
}

export function isLocalHostName(value) {
  const hostname = String(value || '').toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '127-0-0-1.sslip.io';
}

export function isHostMachineName(value) {
  const hostname = String(value || '').toLowerCase();
  if (isLocalHostName(hostname)) return true;
  const addresses = hostMachineAddresses();
  if (addresses.has(normalizedAddress(hostname))) return true;
  const sslip = sslipIpv4(hostname);
  return !!sslip && addresses.has(sslip);
}

export function requestHostIsLocal(req) {
  const direct = hostnameFromHost(req.headers?.host);
  if (!isHostMachineName(direct)) return false;
  const forwardedRaw = String(req.headers?.['x-forwarded-host'] || '').trim();
  if (forwardedRaw && !isHostMachineName(hostnameFromHost(forwardedRaw))) return false;
  return true;
}

export function browserOriginIsLocal(req, { allowNullOrigin = false, allowedExtensionIds = [] } = {}) {
  const origin = String(req.headers?.origin || '').trim();
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)
      && allowedExtensionIds.includes(origin.slice('chrome-extension://'.length))) return true;
  const site = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (site === 'cross-site') return false;
  if (!origin) return true;
  if (origin === 'null') return allowNullOrigin;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && isHostMachineName(parsed.hostname);
  } catch {
    return false;
  }
}

export function isHostLocalRequest(req, options = {}) {
  if (!socketIsHostMachine(req)) return false;
  if (!requestHostIsLocal(req)) return false;
  if (req.headers?.['cf-ray'] || req.headers?.['cf-connecting-ip']) return false;
  return browserOriginIsLocal(req, options);
}
