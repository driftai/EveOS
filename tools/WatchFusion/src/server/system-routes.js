import fs from 'node:fs';
import path from 'node:path';
import { LAN_MODE, PORT, PROJECT_ROOT } from './config.js';
import { counts } from './room-store.js';
import { trustedExtensionIds } from './extension-identity.js';
import { isHostLocalRequest } from './local-request.js';
import {
  isVirtualAddress,
  lanUrls,
  localCanonicalHostUrl,
  networkAddresses,
  originForRequest,
  preferredLanAddress
} from './network.js';
import { json, now } from './http-utils.js';

function remoteTunnelUrl() {
  try {
    const raw = fs.readFileSync(path.join(PROJECT_ROOT, '.runtime', 'remote-url.txt'), 'utf8').trim();
    const url = new URL(raw);
    return url.protocol === 'https:' && /(?:^|\.)trycloudflare\.com$/i.test(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function handleSystemRoute(req, res, parts) {
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'health') {
    const { rooms, aliases } = counts();
    json(res, 200, { ok: true, app: 'WatchFusion', port: PORT, rooms, aliases, time: now(), youtubePlayer: 'iframe-api' });
    return true;
  }

  if (req.method !== 'GET' || parts[0] !== 'api' || parts[1] !== 'network-info') return false;

  if (!isHostLocalRequest(req, { allowNullOrigin: true, allowedExtensionIds: trustedExtensionIds() })) {
    json(res, 403, { error: 'network diagnostics are host-local only' });
    return true;
  }

  const all = networkAddresses();
  const addresses = all.filter(x => x.shareable).map(x => x.address);
  const localOnlyAddresses = all.filter(x => !x.shareable).map(x => x.address);
  const localAddress = `http://127.0.0.1:${PORT}`;
  const localHost = localCanonicalHostUrl(PORT);
  const lanAddresses = addresses.map(address => lanUrls(address, PORT).ip);
  const lanHosts = addresses.map(address => lanUrls(address, PORT).host);
  const preferredAddress = preferredLanAddress();
  const preferredUrls = lanUrls(preferredAddress, PORT);
  const requestOriginHost = originForRequest(req);
  const requestUrls = lanUrls(requestOriginHost, PORT);
  const remoteUrl = remoteTunnelUrl();
  const exposureMode = remoteUrl ? 'cloudflare' : LAN_MODE ? 'lan' : 'local';

  json(res, 200, {
    ok: true,
    app: 'WatchFusion',
    port: PORT,
    exposureMode,
    remoteUrl,
    localAddress,
    localHost,
    localCanonicalHost: localHost,
    preferredLanAddress: preferredUrls.ip,
    preferredLanIp: preferredAddress,
    preferredLanHost: preferredUrls.host,
    lanAddresses,
    lanHosts,
    localOnlyAddresses,
    allLanAddresses: all.map(x => `http://${x.address}:${PORT}`),
    requestOrigin: `http://${requestOriginHost}:${PORT}`,
    requestAddress: requestUrls.ip,
    requestIsVirtual: isVirtualAddress(requestOriginHost),
    transportBridge: preferredUrls.ip || null,
    transportBridgeHost: preferredUrls.host || null,
    canonicalLanHost: preferredUrls.host || null,
    retiredVirtualLan: true,
    retiredVirtualAddresses: localOnlyAddresses,
    sameServer: true,
    localOnly: !LAN_MODE,
    localMode: !LAN_MODE
  });
  return true;
}
