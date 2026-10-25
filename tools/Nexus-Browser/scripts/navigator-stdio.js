'use strict';

// MS-09 experimental, read-only JSONL stdio sidecar. It is not a provider
// endpoint and deliberately has no socket, grant owner, or daemon supervisor.
// A future Nexus-owned lifecycle client must authenticate room and root scopes
// before starting this process; never expose its stdin to remote providers.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createFilesystemBroker } = require('../machine-spaces/filesystem-broker');
const { SCHEMA } = require('../machine-spaces/navigator-path-search');

const PROTOCOL = 'eveos.navigator.jsonl.v1';
const MAX_LINE_BYTES = 4096;
const MAX_REQUESTS = 128;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/;
const root = process.env.EVEOS_NAVIGATOR_ROOT;
if (!root || !path.isAbsolute(root) || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  process.stderr.write('NAVIGATOR_ROOT_REQUIRED: explicit existing absolute root from the owner is required.\n');
  process.exitCode = 2;
} else {
  const broker = createFilesystemBroker();
  const generation = randomUUID();
  const receipts = new Map();
  let pending = '';
  let closed = false;

  function write(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
  function reject(requestId, code, message) { write({ protocol: PROTOCOL, requestId, ok: false, code, message }); }
  function respond(request) {
    if (!request || typeof request !== 'object' || !REQUEST_ID.test(request.requestId)) {
      reject(null, 'NAVIGATOR_BAD_ID', 'Bounded immutable requestId is required.'); return;
    }
    const { requestId } = request;
    const digest = JSON.stringify(request);
    const prior = receipts.get(requestId);
    if (prior) {
      if (prior.digest !== digest) reject(requestId, 'NAVIGATOR_REQUEST_CONFLICT', 'Request ID used with different arguments.');
      else write(prior.response);
      return;
    }
    if (receipts.size >= MAX_REQUESTS) {
      reject(requestId, 'NAVIGATOR_REQUEST_LIMIT', 'Restart the bounded sidecar to admit another request.');
      return;
    }
    let result;
    try {
      switch (request.action) {
        case 'handshake': result = { protocol: PROTOCOL, discoverySchema: SCHEMA, generation }; break;
        case 'nav_status': result = { ...broker.navStatus(root), protocol: PROTOCOL, generation }; break;
        case 'nav_search': result = { ...broker.navSearch(root, request.query, request.options || {}), generation }; break;
        case 'shutdown': result = { generation, stopped: true }; closed = true; break;
        default: throw Object.assign(new Error('Unsupported Navigator operation.'), { code: 'NAVIGATOR_UNKNOWN_ACTION' });
      }
      const response = { protocol: PROTOCOL, requestId, ok: true, result };
      receipts.set(requestId, { digest, response });
      write(response);
    } catch (error) {
      const response = { protocol: PROTOCOL, requestId, ok: false,
        code: error.code || 'NAVIGATOR_FAILED', message: String(error.message || 'Navigator failed.').slice(0, 180) };
      receipts.set(requestId, { digest, response });
      write(response);
    }
    if (closed) process.stdin.pause();
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (closed) return;
    pending += chunk;
    if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES * 2) {
      reject(null, 'NAVIGATOR_LINE_LIMIT', 'JSONL input buffer exceeded its limit.');
      process.stdin.pause(); return;
    }
    let newline;
    while (!closed && (newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        reject(null, 'NAVIGATOR_LINE_LIMIT', 'JSONL request exceeds its limit.');
        continue;
      }
      if (!line) continue;
      try { respond(JSON.parse(line)); }
      catch { reject(null, 'NAVIGATOR_INVALID_JSON', 'Invalid JSONL input.'); }
    }
  });
}
