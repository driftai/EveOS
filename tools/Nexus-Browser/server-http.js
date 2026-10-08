'use strict';

const fs = require('node:fs');
const path = require('node:path');
const terminalRelayStorage = require('./scripts/terminal-relay-storage');
const runtimeConfig = require('./runtime-config');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
});
const INDEX_ENHANCEMENTS = Object.freeze([
  '<script src="/machine-human-gate-ui.js"></script>',
  '<script src="/machine-supervised-jobs-ui.js"></script>',
  '<script src="/machine-request-view-ui.js"></script>'
]);

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; frame-ancestors http://127.0.0.1:* http://localhost:* file:");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function enhanceIndex(data) {
  const html = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  if (!html.includes('</body>')) return html;
  const missing = INDEX_ENHANCEMENTS.filter((tag) => !html.includes(tag));
  if (!missing.length) return html;
  return html.replace('</body>', `  ${missing.join('\n  ')}\n</body>`);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const body = path.basename(filePath) === 'index.html' ? enhanceIndex(data) : data;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
}

function createHttpHandler({ host, port, publicDir, diagnostics }) {
  return function handleHttp(req, res) {
    setSecurityHeaders(res);
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'eveos-nexus-browser', port }));
      return;
    }
    if (url.pathname === '/terminal-relay/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(terminalRelayStorage.readLatestStatus()));
      return;
    }
    if (url.pathname === '/diagnostics') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(diagnostics()));
      return;
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const normalized = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
    const filePath = path.join(publicDir, normalized);
    if (!filePath.startsWith(publicDir)) { res.writeHead(403).end('Forbidden'); return; }
    sendFile(res, filePath);
  };
}

function websocketOriginAllowed(origin, port) {
  if (!origin) return true;
  // file:// EveOS is an explicitly supported local host surface. Browsers serialize its
  // websocket Origin as "null"; the socket itself still terminates on loopback and the
  // privileged workspace-host registration is additionally restricted by qualification routing.
  if (origin === 'null') return true;
  if (/^chrome-extension:\/\/[a-p]{32}$/i.test(origin)) return true;
  try {
    const parsed = new URL(origin);
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    if (!loopback) return false;
    const originPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (originPort === Number(port)) return true;
    // Search Monitor lives on EveOS Web, not the Nexus port. Permit only that registered
    // loopback origin so the page can act as the owner of its already-open local chat workspaces.
    try {
      return originPort === Number(runtimeConfig.registryPort('EVEOS_WEB_PORT'));
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

module.exports = { INDEX_ENHANCEMENTS, enhanceIndex, createHttpHandler, websocketOriginAllowed };
