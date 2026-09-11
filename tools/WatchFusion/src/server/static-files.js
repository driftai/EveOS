import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC, PROJECT_ROOT } from './config.js';
import { json } from './http-utils.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function resolveContainedFile(root, candidate) {
  let realRoot;
  let realFile;
  let stat;
  try {
    realRoot = await fs.promises.realpath(root);
    realFile = await fs.promises.realpath(candidate);
    if (!isContainedPath(realRoot, realFile)) return null;
    stat = await fs.promises.stat(realFile);
  } catch {
    return null;
  }
  return stat.isFile() ? { root: realRoot, file: realFile, stat } : null;
}

async function readContainedPublicText(name) {
  const publicRoot = path.resolve(PUBLIC);
  const candidate = path.resolve(publicRoot, name);
  if (!isContainedPath(publicRoot, candidate)) throw new Error('path outside public root');
  const resolved = await resolveContainedFile(publicRoot, candidate);
  if (!resolved) throw new Error(`public client file is missing or escaped containment: ${name}`);
  return fs.promises.readFile(resolved.file, 'utf8');
}

export async function sendFile(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try { pathname = decodeURIComponent(requestUrl.pathname); } catch { return json(res, 400, { error: 'bad path' }); }

  if (pathname === '/vendor/hls.js') {
    return sendLocalDependency(res, path.join(PROJECT_ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js'), 'text/javascript; charset=utf-8');
  }

  if (pathname === '/' || /^\/watch\/[A-Za-z0-9_-]{3,32}\/?$/i.test(pathname)) pathname = '/index.html';
  const relative = pathname.replace(/^\/+/, '');
  const publicRoot = path.resolve(PUBLIC);
  const candidate = path.resolve(publicRoot, relative);

  if (!isContainedPath(publicRoot, candidate)) return json(res, 403, { error: 'path outside public root' });

  if (relative.replace(/\\/g, '/').toLowerCase() === 'app.js') {
    const clientFiles = [
      'client/core.js',
      'client/room-connection.js',
      'client/provider-registry.js',
      'client/render.js',
      'client/youtube-player.js',
      'client/commands.js',
      'client/media-player.js',
      'client/media-controls.js',
      'client/realtime.js',
      'client/nuvio-native-viewport-connector.js',
      'client/nuvio-player-input-fix.js',
      'client/nuvio-adapter.js',
      'client/voxelvision-adapter.js',
      'client/setup-health.js',
      'client/eveos-embed-bridge.js',
      'client/bootstrap.js',
      'client/watchfusion-host-input-fix.js',
      'playback-sync.js'
    ];
    try {
      const parts = await Promise.all(clientFiles.map(name => readContainedPublicText(name)));
      const bundle = `${parts.filter(Boolean).join('\n\n')}\n`;
      const buf = Buffer.from(bundle, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      });
      res.end(bundle);
    } catch {
      json(res, 500, { error: 'could not bundle app.js' });
    }
    return;
  }

  const resolved = await resolveContainedFile(publicRoot, candidate);
  if (!resolved) return json(res, 404, { error: 'not found' });

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(resolved.file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': resolved.stat.size,
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(resolved.file).pipe(res);
}

function sendLocalDependency(res, file, contentType) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 503, { error: 'HLS.js dependency is not installed. Run npm install.' });
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400, immutable' });
    fs.createReadStream(file).pipe(res);
  });
}
