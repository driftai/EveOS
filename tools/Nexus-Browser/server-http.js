'use strict';

const fs = require('node:fs');
const path = require('node:path');
const terminalRelayStorage = require('./scripts/terminal-relay-storage');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
});

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; frame-ancestors http://127.0.0.1:* http://localhost:* file:");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
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
  if (/^chrome-extension:\/\/[a-p]{32}$/i.test(origin)) return true;
  try {
    const parsed = new URL(origin);
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    return loopback && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === Number(port);
  } catch {
    return false;
  }
}

module.exports = { createHttpHandler, websocketOriginAllowed };
