import http from 'node:http';
import { PORT, HOST, LAN_MODE } from './src/server/config.js';
import { applyApiCors, isApiRequest, json } from './src/server/http-utils.js';
import {
  isHtmlNavigation,
  isVirtualAddress,
  lanUrls,
  localCanonicalHostUrl,
  originForRequest,
  preferredLanAddress,
  logNetworkStartup
} from './src/server/network.js';
import { pruneRooms } from './src/server/room-store.js';
import { handleMediaRoute } from './src/server/media-routes.js';
import { handleMediaStateRoute } from './src/server/media-state-route.js';
import { handleNuvioRoute } from './src/server/nuvio-routes.js';
import { handleVoxelVisionRoute } from './src/server/voxelvision-routes.js';
import { handleRoomRoute } from './src/server/room-routes.js';
import { sendFile } from './src/server/static-files.js';
import { handleSystemRoute } from './src/server/system-routes.js';
import { handleSetupRoute } from './src/server/setup-routes.js';
import { attachRealtime } from './src/server/realtime.js';

function shouldRedirectToCanonicalHost(req, url) {
  if (isApiRequest(req) || !isHtmlNavigation(req)) return null;
  const requestHost = originForRequest(req), physicalLan = preferredLanAddress();
  const physicalHost = physicalLan ? lanUrls(physicalLan, PORT).host : null;
  const localHost = localCanonicalHostUrl(PORT);
  const isPhysicalIpHost = physicalLan && requestHost === physicalLan;
  const isVirtualIpHost = isVirtualAddress(requestHost);
  const isRetiredVirtualSslip = /^192-168-128-1\.sslip\.io$/i.test(requestHost);
  const isLocalLoopback = /^(localhost|127\.0\.0\.1)$/i.test(requestHost);
  if (isLocalLoopback) return `${localHost}${url.pathname}${url.search}`;
  if (physicalHost && (isPhysicalIpHost || isVirtualIpHost || isRetiredVirtualSslip)) return `${physicalHost}${url.pathname}${url.search}`;
  return null;
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      applyApiCors(req, res);
      if (req.method === 'OPTIONS' && isApiRequest(req)) {
        res.writeHead(204);
        return res.end();
      }
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const parts = url.pathname.split('/').filter(Boolean);
      const canonicalTarget = shouldRedirectToCanonicalHost(req, url);
      if (canonicalTarget) {
        res.writeHead(302, { Location: canonicalTarget, 'Cache-Control': 'no-store' });
        return res.end();
      }

      if (handleSystemRoute(req, res, parts)) return;
      if (await handleSetupRoute(req, res, parts) !== false) return;
      if (await handleMediaRoute(req, res, parts) !== false) return;
      if (await handleMediaStateRoute(req, res, parts) !== false) return;

      const nuvioHandled = await handleNuvioRoute(req, res, url.pathname, url);
      if (nuvioHandled !== false) return;

      const voxelVisionHandled = await handleVoxelVisionRoute(req, res, url.pathname);
      if (voxelVisionHandled !== false) return;

      if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
        const handled = await handleRoomRoute(req, res, url, parts);
        if (handled !== false) return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') return sendFile(req, res);
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      console.error(error);
      return json(res, 500, { error: 'server error' });
    }
  });

  attachRealtime(server);
  setInterval(pruneRooms, 10000).unref();
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const appServer = createServer();
  appServer.listen(PORT, HOST, () => {
    logNetworkStartup({ port: PORT, host: HOST, lanMode: LAN_MODE });
  });
}
