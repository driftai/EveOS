import dns from 'node:dns/promises';
import net from 'node:net';

const cache = new Map();

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && b >= 18 && b <= 19)
    || (a === 198 && b === 51) || (a === 203 && b === 0) || a >= 224;
}

function isPrivateIpv6(address) {
  const value = String(address || '').toLowerCase();
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff')) return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7);
    if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }
  return false;
}

export async function assertPublicHttpUrl(input) {
  const url = input instanceof URL ? input : new URL(String(input || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public http(s) URLs without embedded credentials are supported.');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Private or loopback destinations are not allowed.');
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (literalFamily === 4 ? isPrivateIpv4(hostname) : isPrivateIpv6(hostname)) {
      throw new Error('Private or loopback destinations are not allowed.');
    }
    return url.href;
  }
  let records = cache.get(hostname);
  if (!records) {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
    cache.set(hostname, records);
  }
  if (!records.length) throw new Error('The requested destination has no public address.');
  for (const { address } of records) {
    const family = net.isIP(address);
    if (!family || (family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address))) {
      throw new Error('The requested destination is not public.');
    }
  }
  return url.href;
}

export async function isPublicHttpUrl(input) {
  try {
    await assertPublicHttpUrl(input);
    return true;
  } catch {
    return false;
  }
}
