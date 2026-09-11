import http from 'http';
import fs from 'fs';
import { parseByteRange, streamMedia } from './media-range.js';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  getYoutubeStatus,
  isSupportedYoutubeUrl,
  normalizeYoutubeQuality,
  runYoutubeImport
} from './youtube-import.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '9095', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_JSON_BODY = 16 * 1024;

const MIME_TYPES = {
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
  '.bin': 'application/octet-stream'
};

let youtubeImportBusy = false;

function buildContentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    // ONNX Runtime loads its cross-origin execution-provider module through a
    // same-origin Blob URL. worker-src permits the worker itself; script-src
    // must separately permit that worker's dynamic module import.
    "script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co"
  ].join('; ');
}

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': buildContentSecurityPolicy(),
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});

function responseHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}

function isLoopbackAddress(address = '') {
  const normalized = String(address).toLowerCase();
  return normalized === '::1'
    || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.');
}

function hasTrustedApiOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host && ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function canUseLocalApi(req) {
  return isLoopbackAddress(req.socket.remoteAddress) && hasTrustedApiOrigin(req);
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, responseHeaders({
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }));
  res.end(body);
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

function getSystemHardware() {
  const cpus = os.cpus() || [];
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() || null,
    logicalCores: cpus.length || null,
    totalMemoryGb: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
    gpuLabels: detectSystemGpus()
  };
}

const SYSTEM_HARDWARE = getSystemHardware();

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_JSON_BODY) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const relativePath = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${relativePath}`);
  const publicRoot = path.resolve(PUBLIC_DIR);

  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
    res.writeHead(403, responseHeaders({ 'Content-Type': 'text/plain; charset=UTF-8' }));
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, responseHeaders({ 'Content-Type': 'text/plain; charset=UTF-8' }));
      res.end(`404 Not Found: ${relativePath}`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const totalSize = stats.size;
    const range = req.headers.range;

    if (range) {
      const parsed = parseByteRange(range, totalSize);
      if (!parsed) {
        res.writeHead(416, responseHeaders({ 'Content-Range': `bytes */${totalSize}` }));
        res.end();
        return;
      }

      const { start, end } = parsed;

      const chunkSize = (end - start) + 1;
      res.writeHead(206, responseHeaders({
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      }));
      if (req.method === 'HEAD') {
        res.end();
      } else {
        streamMedia(req, res, filePath, { start, end });
      }
      return;
    }

    res.writeHead(200, responseHeaders({
      'Content-Length': totalSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600'
    }));
    if (req.method === 'HEAD') {
      res.end();
    } else {
      streamMedia(req, res, filePath);
    }
  });
}

const server = http.createServer(async (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, responseHeaders({ 'Content-Type': 'text/plain; charset=UTF-8' }));
    res.end('400 Bad Request');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch {
    res.writeHead(400, responseHeaders({ 'Content-Type': 'text/plain; charset=UTF-8' }));
    res.end('400 Bad Request');
    return;
  }

  if (pathname.startsWith('/api/') && !canUseLocalApi(req)) {
    json(res, 403, { ok: false, error: 'Local API access only.' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    json(res, 200, {
      name: 'VoxelVision',
      version: '1.9.7',
      status: 'ready',
      port: PORT,
      hardware: SYSTEM_HARDWARE,
      youtube: {
        ...getYoutubeStatus(),
        busy: youtubeImportBusy
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/hardware') {
    json(res, 200, SYSTEM_HARDWARE);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/youtube/status') {
    json(res, 200, {
      ...getYoutubeStatus(),
      busy: youtubeImportBusy
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/youtube/import') {
    if (youtubeImportBusy) {
      json(res, 409, { ok: false, error: 'Another YouTube import is already running.' });
      return;
    }

    try {
      const body = await readJson(req);
      const sourceUrl = typeof body.url === 'string' ? body.url.trim() : '';
      if (!isSupportedYoutubeUrl(sourceUrl)) {
        json(res, 400, { ok: false, error: 'Enter a valid youtube.com or youtu.be URL.' });
        return;
      }

      const quality = normalizeYoutubeQuality(body.quality);
      youtubeImportBusy = true;
      const imported = await runYoutubeImport(sourceUrl, quality);
      json(res, 200, { ok: true, ...imported });
    } catch (err) {
      json(res, 500, { ok: false, error: err?.message || 'YouTube import failed.' });
    } finally {
      youtubeImportBusy = false;
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, responseHeaders({ 'Content-Type': 'text/plain; charset=UTF-8', Allow: 'GET, HEAD, POST' }));
    res.end('405 Method Not Allowed');
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const youtube = getYoutubeStatus();
  console.log('============================================================');
  console.log('   VOXELVISION STANDALONE TOOL SERVER v1.9.7');
  console.log(`   Running at: http://${HOST}:${PORT}`);
  console.log(`   Serving: ${PUBLIC_DIR}`);
  console.log(`   Machine: ${SYSTEM_HARDWARE.cpuModel || 'CPU'} · ${SYSTEM_HARDWARE.logicalCores || '?'} threads · ${SYSTEM_HARDWARE.totalMemoryGb || '?'} GB RAM`);
  console.log(`   GPU: ${SYSTEM_HARDWARE.gpuLabels.join(' + ') || 'browser detection fallback'}`);
  console.log(`   YouTube bridge: ${youtube.provider || 'not installed (use VoxelVision.bat setup)'}`);
  console.log(`   FFmpeg merge: ${youtube.ffmpegProvider || 'not installed (combined streams only)'}`);
  console.log(`   YouTube quality: ${youtube.defaultQuality}p default + 720/1440/2160/source-max options`);
  console.log('   Live depth: DA3 FP16 hybrid WebGPU + Q8/WASM + automatic DA2 compatibility fallback');
  console.log('   Conversion paths: AI model only + local luminance + AI/decoded-video fusion');
  console.log('   Hybrid playback: reload-safe best-profile resume + cross-profile reuse + persistent 16-bit depth');
  console.log('   Cache-first replay: canonical YouTube IDs + stored depth before optional AI recovery');
  console.log('   Render fusion: chained temporal alignment + mask-guided foreground detail + continuous translation');
  console.log('   Cache library: grouped videos + replay/recalibration/scoring + per-video/all-cache removal');
  console.log('   Load stability: cache-first lazy UI + serialized AI startup + temporary GPU-pressure relief');
  console.log('   Model safety: isolated worker backends + real warm-up validation + patch/aspect/direction profiles');
  console.log('   Far-field quality: DA2 inverse-depth log transfer prevents distant geometry collapsing into shelves');
  console.log('   Depth fidelity: Float32 geometry + adaptive multi-axis bias correction + confidence-gated color guidance');
  console.log('   Border protection: localized aspect-relative edge analysis tapers only unsupported extreme bands');
  console.log('   Quality tuning: manual lock default + detail-priority and motion-priority adaptive modes');
  console.log('   Diagnostics: synchronized depth views + presented depth/color stability scoring');
  console.log('   Luma guidance: 256 detail / 4 FPS recommended, not hard-capped; float bilateral smoothing remains active');
  console.log('   Frame sync: decoded media timestamps + chained depth endpoints + continuous handoffs');
  console.log('   Stability: stale-job cancellation + seek resets + three-strike AI fallback protection');
  console.log('   Temporal quality: asymmetric range anchors + camera-motion compensation + scene-cut resets');
  console.log('   Camera: eased linear wheel zoom + linear middle-drag + mild cursor focus');
  console.log('============================================================');
});
