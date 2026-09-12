import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VOXELVISION_PUBLIC } from './config.js';
import { json, readBody } from './http-utils.js';
import { isHostLocalRequest } from './local-request.js';
import { parseByteRange, streamMedia } from '../../voxelvision/media-range.js';
import {
  getYoutubeStatus,
  isSupportedYoutubeUrl,
  normalizeYoutubeQuality,
  runYoutubeImport
} from '../../voxelvision/youtube-import.js';

const VERSION = '1.9.7';
const MAX_SOURCE_URL_LENGTH = 2048;
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.mjs': 'text/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm'
});

let youtubeImportBusy = false;

function requestHostname(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try { return new URL(`http://${raw}`).hostname; } catch { return ''; }
}

function frameAncestors(req) {
  const values = new Set([
    "'self'",
    'http://127.0.0.1:*',
    'http://localhost:*'
  ]);
  const hostname = requestHostname(req);
  if (hostname && /^[A-Za-z0-9.:-]+$/.test(hostname)) {
    values.add(`http://${hostname}:*`);
    values.add(`https://${hostname}:*`);
  }
  return [...values].join(' ');
}

function buildContentSecurityPolicy(req) {
  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co"
  ];

  // EveOS still supports a file:// host shell. A file document has an opaque
  // ancestor origin, so no frame-ancestors allow-list can name it reliably.
  // Only omit frame-ancestors when the request is proven host-local by the
  // centralized socket/host/browser boundary. LAN and Cloudflare requests keep
  // the clickjacking boundary below.
  if (!isHostLocalRequest(req)) {
    directives.splice(3, 0, `frame-ancestors ${frameAncestors(req)}`);
  }
  return directives.join('; ');
}

function securityHeaders(req) {
  return {
    'Content-Security-Policy': buildContentSecurityPolicy(req),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  };
}

function requestHasTrustedOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site';
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const requestHosts = [req.headers.host, req.headers['x-forwarded-host']]
      .flatMap(value => String(value || '').split(','))
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
    return requestHosts.includes(originHost);
  } catch {
    return false;
  }
}

function runTextCommand(command, args = []) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    if (result.error || result.status !== 0) return '';
    return String(result.stdout || '').trim();
  } catch {
    return '';
  }
}

function detectSystemGpus() {
  let output = '';
  if (process.platform === 'win32') {
    output = runTextCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"
    ]);
  } else if (process.platform === 'darwin') {
    output = runTextCommand('sh', ['-lc', "system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2}'"]);
  } else if (process.platform === 'linux') {
    output = runTextCommand('sh', ['-lc', "lspci 2>/dev/null | grep -Ei 'VGA|3D|Display' | sed 's/^.*: //' "]);
  }
  return [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(Boolean))].slice(0, 8);
}

const cpus = os.cpus() || [];
const SYSTEM_HARDWARE = Object.freeze({
  platform: process.platform,
  arch: process.arch,
  cpuModel: cpus[0]?.model?.trim() || null,
  logicalCores: cpus.length || null,
  totalMemoryGb: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
  gpuLabels: detectSystemGpus()
});
const REDACTED_HARDWARE = Object.freeze({
  platform: null,
  arch: null,
  cpuModel: null,
  logicalCores: null,
  totalMemoryGb: null,
  gpuLabels: [],
  redacted: true
});

function youtubeStatusForRequest(hostLocal) {
  const status = getYoutubeStatus();
  if (hostLocal) return { ...status, busy: youtubeImportBusy, remoteDisabled: false };
  return {
    ...status,
    available: false,
    provider: null,
    ffmpegAvailable: false,
    ffmpegProvider: null,
    ffprobeAvailable: false,
    ffprobeProvider: null,
    busy: false,
    remoteDisabled: true
  };
}

export function isContainedVoxelVisionPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function serveVoxelVisionFile(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'bad path' }); }
  const relative = decoded === '/voxelvision/' ? 'index.html' : decoded.slice('/voxelvision/'.length);
  const publicRoot = path.resolve(VOXELVISION_PUBLIC);
  const candidate = path.resolve(publicRoot, relative);
  if (!isContainedVoxelVisionPath(publicRoot, candidate)) return json(res, 403, { error: 'forbidden' });

  let stat;
  let file;
  try {
    [file, stat] = await Promise.all([fs.promises.realpath(candidate), fs.promises.stat(candidate)]);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
  if (!stat.isFile() || !isContainedVoxelVisionPath(publicRoot, file)) return json(res, 403, { error: 'forbidden' });

  const headers = {
    ...securityHeaders(req),
    'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': /\.(?:html|css|js|mjs)$/i.test(file) ? 'no-cache' : 'public, max-age=3600'
  };
  const range = req.headers.range;
  if (range) {
    const parsed = parseByteRange(range, stat.size);
    if (!parsed) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    const { start, end } = parsed;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': (end - start) + 1
    });
    if (req.method === 'HEAD') return res.end();
    streamMedia(req, res, file, { start, end });
    return true;
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  streamMedia(req, res, file);
  return true;
}

async function handleVoxelVisionApi(req, res, pathname) {
  if (!requestHasTrustedOrigin(req)) return json(res, 403, { ok: false, error: 'Same-origin access required.' });
  const hostLocal = isHostLocalRequest(req);

  if (req.method === 'GET' && pathname === '/voxelvision/api/status') {
    return json(res, 200, {
      name: 'VoxelVision',
      version: VERSION,
      status: 'ready',
      mounted: true,
      hostLocal,
      hardware: hostLocal ? SYSTEM_HARDWARE : REDACTED_HARDWARE,
      youtube: youtubeStatusForRequest(hostLocal)
    });
  }
  if (req.method === 'GET' && pathname === '/voxelvision/api/hardware') {
    return json(res, 200, hostLocal ? SYSTEM_HARDWARE : REDACTED_HARDWARE);
  }
  if (req.method === 'GET' && pathname === '/voxelvision/api/youtube/status') {
    return json(res, 200, youtubeStatusForRequest(hostLocal));
  }
  if (req.method === 'POST' && pathname === '/voxelvision/api/youtube/import') {
    if (!hostLocal) return json(res, 403, { ok: false, error: 'Host-local access required for YouTube import.' });
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return json(res, 415, { ok: false, error: 'Content-Type must be application/json.' });
    }
    if (youtubeImportBusy) return json(res, 409, { ok: false, error: 'Another YouTube import is already running.' });
    try {
      const body = await readBody(req);
      const sourceUrl = typeof body.url === 'string' ? body.url.trim() : '';
      if (sourceUrl.length > MAX_SOURCE_URL_LENGTH || !isSupportedYoutubeUrl(sourceUrl)) {
        return json(res, 400, { ok: false, error: 'Enter a valid youtube.com or youtu.be URL.' });
      }
      youtubeImportBusy = true;
      const imported = await runYoutubeImport(sourceUrl, normalizeYoutubeQuality(body.quality));
      return json(res, 200, { ok: true, ...imported, mediaUrl: `/voxelvision${imported.mediaUrl}` });
    } catch (error) {
      return json(res, 500, { ok: false, error: error?.message || 'YouTube import failed.' });
    } finally {
      youtubeImportBusy = false;
    }
  }
  return json(res, 404, { error: 'not found' });
}

export async function handleVoxelVisionRoute(req, res, pathname) {
  if (pathname === '/__voxelvision__/entry') {
    const built = fs.existsSync(path.join(VOXELVISION_PUBLIC, 'index.html'));
    return json(res, 200, {
      ok: built,
      path: built ? '/voxelvision/' : null,
      version: built ? VERSION : null,
      message: built ? 'VoxelVision is ready' : 'VoxelVision source is missing from voxelvision/.'
    });
  }
  if (pathname === '/voxelvision') {
    res.writeHead(302, { Location: '/voxelvision/', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (pathname.startsWith('/voxelvision/api/')) return handleVoxelVisionApi(req, res, pathname);
  if (pathname.startsWith('/voxelvision/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveVoxelVisionFile(req, res, pathname);
  }
  return false;
}
