import fs from 'node:fs';
import path from 'node:path';
import { NUVIO_DIST } from './config.js';
import { json } from './http-utils.js';
import { isHostLocalRequest } from './local-request.js';
import {
  isNuvioBuilt,
  generateNuvioEnvScript,
  hardenNuvioYoutubeProxyHtml,
  mergedNuvioConfig
} from './nuvio-config.js';
import { handleNuvioAddonProxy } from './nuvio-proxy.js';
import { handleNuvioPluginFetch } from './nuvio-plugin-proxy.js';

const NUVIO_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8'
});

export function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function handleNuvioRoute(req, res, pathname, url) {
  if (pathname === '/__nuvio__/entry' || pathname === '/__wrapper__/nuvio-entry') {
    if (!isNuvioBuilt(NUVIO_DIST)) {
      return json(res, 200, {
        ok: false,
        path: null,
        message: 'Nuvio browser build is missing. Run GET-NUVIO.bat or BUILD-NUVIO.bat.'
      });
    }
    return json(res, 200, {
      ok: true,
      path: '/nuvio/dist/index.html',
      message: 'Nuvio browser build is ready'
    });
  }

  if (
    pathname === '/__nuvio__/env.js' ||
    pathname === '/__wrapper__/nuvio-env.js' ||
    pathname === '/nuvio/dist/nuvio.env.js' ||
    pathname === '/nuvio/nuvio.env.js' ||
    pathname === '/nuvio.env.js' ||
    pathname.endsWith('/nuvio.env.js')
  ) {
    const script = await generateNuvioEnvScript(NUVIO_DIST);
    const buf = Buffer.from(script, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
    return true;
  }

  if (pathname === '/__nuvio__/diagnostics' || pathname === '/__wrapper__/diagnostics') {
    if (!isHostLocalRequest(req)) return json(res, 403, { error: 'Nuvio diagnostics are host-local only' });
    const { merged, keySource } = await mergedNuvioConfig(NUVIO_DIST);
    return json(res, 200, {
      built: isNuvioBuilt(NUVIO_DIST),
      backend: merged.NUVIO_SUPABASE_URL,
      qrConfigured: Boolean(merged.NUVIO_SUPABASE_URL && merged.NUVIO_SUPABASE_ANON_KEY),
      keySource,
      tvLogin: merged.TV_LOGIN_WEB_BASE_URL
    });
  }

  if (pathname === '/__nuvio__/youtube-proxy.html' || pathname === '/__wrapper__/youtube-proxy.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    const proxyPath = path.join(NUVIO_DIST, 'youtube-proxy.html');
    let html;
    try { html = await fs.promises.readFile(proxyPath, 'utf8'); }
    catch { return json(res, 404, { error: 'Nuvio YouTube proxy is missing' }); }
    const body = Buffer.from(hardenNuvioYoutubeProxyHtml(html), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  if (pathname === '/__nuvio__/plugin-fetch') {
    if (!isHostLocalRequest(req)) return json(res, 403, { error: 'Nuvio plugin networking is host-local only' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    return handleNuvioPluginFetch(req, res);
  }

  if (pathname === '/__nuvio__/addon-proxy' || pathname === '/__wrapper__/addon-proxy') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const target = url.searchParams.get('url');
    if (!target) return json(res, 400, { error: 'missing url parameter' });
    return handleNuvioAddonProxy(req, res, target);
  }

  if (pathname === '/nuvio' || pathname === '/nuvio/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    if (!isNuvioBuilt(NUVIO_DIST)) return json(res, 404, { error: 'Nuvio browser build is missing' });
    res.writeHead(302, { Location: '/nuvio/dist/index.html', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  if (pathname.startsWith('/nuvio/dist/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    let rel;
    try { rel = decodeURIComponent(pathname.slice('/nuvio/dist/'.length)); }
    catch { return json(res, 400, { error: 'bad path' }); }
    let root;
    try { root = await fs.promises.realpath(NUVIO_DIST); }
    catch { return json(res, 404, { error: 'Nuvio browser build is missing' }); }
    const candidate = path.resolve(root, rel);
    if (!isContainedPath(root, candidate)) return json(res, 403, { error: 'forbidden' });

    let file;
    let stat;
    try {
      file = await fs.promises.realpath(candidate);
      stat = await fs.promises.stat(file);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    if (!stat.isFile() || !isContainedPath(root, file)) return json(res, 403, { error: 'forbidden' });
    res.writeHead(200, {
      'Content-Type': NUVIO_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
    return true;
  }

  return false;
}
