import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_CHAT_IMAGE_BYTES } from './config.js';
import { json, readBody, readBytes } from './http-utils.js';
import { isHostLocalRequest, socketIsLoopback } from './local-request.js';
import { networkAddresses } from './network.js';
import { appendImageChat, broadcastState, getRoomAttachment, publicState } from './room-store.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function detectedImageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function imageName(value, type) {
  let decoded = '';
  try { decoded = decodeURIComponent(String(value || '')); } catch { decoded = String(value || ''); }
  const clean = decoded.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 96);
  const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[type];
  return clean || `watchfusion-image${extension}`;
}

function hostNameFromHeader(value) {
  const raw = String(value || '').split(',')[0].trim();
  if (!raw) return '';
  try { return new URL(`http://${raw}`).hostname.toLowerCase(); } catch { return ''; }
}

function normalizedRemoteAddress(req) {
  const raw = String(req.socket?.remoteAddress || '').toLowerCase().split('%')[0];
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function hostMachineNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1', '127-0-0-1.sslip.io']);
  for (const entry of networkAddresses()) {
    names.add(String(entry.address || '').toLowerCase());
    if (entry.address) names.add(`${entry.address.replaceAll('.', '-')}.sslip.io`.toLowerCase());
  }
  return names;
}

function isHostMachineClipboardRequest(req) {
  if (req.headers?.['cf-ray'] || req.headers?.['cf-connecting-ip']) return false;
  const names = hostMachineNames();
  const remote = normalizedRemoteAddress(req);
  const ownAddresses = new Set(networkAddresses().map(entry => String(entry.address || '').toLowerCase()));
  if (!socketIsLoopback(req) && !ownAddresses.has(remote)) return false;
  if (!names.has(hostNameFromHeader(req.headers?.host))) return false;
  const origin = String(req.headers?.origin || '').trim();
  if (!origin) return true;
  if (origin === 'null') return socketIsLoopback(req);
  try { return names.has(new URL(origin).hostname.toLowerCase()); } catch { return false; }
}

async function copyAttachmentToWindowsClipboard(attachment) {
  if (process.platform !== 'win32') return false;
  const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[attachment.type] || '.img';
  const tempPath = path.join(os.tmpdir(), `watchfusion-clipboard-${process.pid}-${Date.now()}${extension}`);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bytes = [System.IO.File]::ReadAllBytes($env:WATCHFUSION_CLIPBOARD_IMAGE)
$stream = New-Object System.IO.MemoryStream(,$bytes)
$source = $null
$bitmap = $null
try {
  $source = [System.Drawing.Image]::FromStream($stream)
  $bitmap = New-Object System.Drawing.Bitmap $source
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    try {
      [System.Windows.Forms.Clipboard]::SetImage($bitmap)
      exit 0
    } catch {
      Start-Sleep -Milliseconds 120
    }
  }
  exit 2
} finally {
  if ($bitmap) { $bitmap.Dispose() }
  if ($source) { $source.Dispose() }
  $stream.Dispose()
}
`;
  try {
    await fs.promises.writeFile(tempPath, attachment.bytes);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const exitCode = await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
        windowsHide: true,
        env: { ...process.env, WATCHFUSION_CLIPBOARD_IMAGE: tempPath },
        stdio: 'ignore'
      });
      const timer = setTimeout(() => { child.kill(); resolve(-1); }, 6000);
      child.once('error', () => { clearTimeout(timer); resolve(-1); });
      child.once('exit', code => { clearTimeout(timer); resolve(Number(code ?? -1)); });
    });
    return exitCode === 0;
  } catch {
    return false;
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

async function copyImageToHostClipboard(req, res, room, attachmentId) {
  if (!isHostMachineClipboardRequest(req)) return json(res, 403, { error: 'Host clipboard copy is available only on the computer running WatchFusion.' });
  const attachment = getRoomAttachment(room, attachmentId);
  if (!attachment) return json(res, 404, { error: 'image not found' });
  if (process.platform !== 'win32') return json(res, 501, { error: 'Native image clipboard copy is currently available on Windows hosts.' });
  const copied = await copyAttachmentToWindowsClipboard(attachment);
  return copied
    ? json(res, 200, { ok: true, copied: 'image' })
    : json(res, 500, { error: 'Windows could not place the image on the clipboard.' });
}


async function uploadImage(req, res, room, member) {
  const declaredType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(declaredType)) return json(res, 415, { error: 'Choose a JPEG, PNG, WebP, or GIF image.' });
  const bytes = await readBytes(req, { maxBytes: MAX_CHAT_IMAGE_BYTES });
  const detectedType = detectedImageType(bytes);
  if (!detectedType || detectedType !== declaredType) return json(res, 415, { error: 'The selected file is not a valid supported image.' });
  return appendUploadedImage(res, room, member, bytes, detectedType, req.headers['x-file-name']);
}

function appendUploadedImage(res, room, member, bytes, type, name) {
  const attachment = appendImageChat(room, member, { bytes, type, name: imageName(name, type) });
  if (!attachment) return json(res, 400, { error: 'Image could not be added to the room.' });
  room.lastActivity = Date.now();
  broadcastState(room);
  return json(res, 201, { ok: true, attachmentId: attachment.id, state: publicState(room) });
}

function normalizedLocalPath(value) {
  let candidate = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!candidate) return null;
  if (/^file:\/\//i.test(candidate)) {
    try { candidate = fileURLToPath(candidate); } catch { return null; }
  }
  if (/^(?:\\\\|\/\/)/.test(candidate)) return null;
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) ? candidate : null;
}

async function uploadImagePath(req, res, room, member) {
  if (!isHostLocalRequest(req)) return json(res, 403, { error: 'Local image paths are available only on the host machine.' });
  const body = await readBody(req, { maxBytes: 4096 });
  const filePath = normalizedLocalPath(body.path);
  if (!filePath) return json(res, 400, { error: 'Paste an absolute local image path.' });
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return json(res, 400, { error: 'The pasted path is not a file.' });
    if (stat.size > MAX_CHAT_IMAGE_BYTES) return json(res, 413, { error: 'Image is larger than 12 MB.' });
    const bytes = await fs.promises.readFile(filePath);
    const detectedType = detectedImageType(bytes);
    if (!detectedType) return json(res, 415, { error: 'The pasted path is not a valid JPEG, PNG, WebP, or GIF image.' });
    const name = path.win32.isAbsolute(filePath) ? path.win32.basename(filePath) : path.basename(filePath);
    return appendUploadedImage(res, room, member, bytes, detectedType, name);
  } catch {
    return json(res, 404, { error: 'The local image path could not be read.' });
  }
}

function sendImage(req, res, room, attachmentId) {
  const attachment = getRoomAttachment(room, attachmentId);
  if (!attachment) return json(res, 404, { error: 'image not found' });
  res.writeHead(200, {
    'Content-Type': attachment.type,
    'Content-Length': attachment.size,
    'Content-Disposition': `inline; filename="image"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    'Cache-Control': 'private, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  return req.method === 'HEAD' ? res.end() : res.end(attachment.bytes);
}

export async function handleRoomImageRoute(req, res, parts, room, member) {
  if (parts[3] !== 'attachments') return false;
  if (req.method === 'POST' && !parts[4]) return uploadImage(req, res, room, member);
  if (req.method === 'POST' && parts[4] === 'path') return uploadImagePath(req, res, room, member);
  if (req.method === 'POST' && parts[4] && parts[5] === 'copy-local') return copyImageToHostClipboard(req, res, room, parts[4]);
  if ((req.method === 'GET' || req.method === 'HEAD') && parts[4] && !parts[5]) return sendImage(req, res, room, parts[4]);
  return json(res, 405, { error: 'method not allowed' });
}
