#!/usr/bin/env node
'use strict';
// Terminal-origin user messages, NOT agent impersonation. An explicit room and
// request ID are preserved for safe manual outcome inspection on timeouts.
const fs = require('node:fs');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const urls = () => require('../runtime-config').urls();
const WAIT_POLL_MS = 10000;

function argumentsFor(argv = []) {
  const [command, ...tokens] = argv;
  if (!['bootstrap', 'rooms', 'inspect', 'send', 'check', 'wait', 'tui', 'viewer-standby'].includes(command)) throw Error('Use rooms, inspect, send, check, wait, tui, or viewer-standby.');
  const p = { command };
  for (let i = 0; i < tokens.length; i += 1) {
    const key = tokens[i];
    if (!['--room','--name','--text','--file','--request-id','--lookup-id','--timeout','--limit','--duration'].includes(key) || i + 1 >= tokens.length || tokens[i + 1].startsWith('--'))
      throw Error(`Unexpected/missing argument ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (Object.hasOwn(p, name)) throw Error(`Repeated argument ${key}`);
    p[name] = tokens[++i];
  }
  if (!['rooms','bootstrap','viewer-standby'].includes(command) && !/^room-[A-Za-z0-9_-]{6,125}$/.test(p.room || '')) throw Error('Use --room EXACT_ROOM_ID (not a name).');
  if (p.file && p.text) throw Error('Choose either --text or --file.');
  if (p.file) {
    const stat = fs.statSync(p.file);
    if (!stat.isFile() || stat.size > 1800) throw Error('File must contain no more than 1800 UTF-8 bytes.');
    p.text = fs.readFileSync(p.file, 'utf8');
  }
  if (command === 'send' && (!p.text || !p.text.trim())) throw Error('send requires --text or --file.');
  if (p.timeout != null && (!Number.isInteger(Number(p.timeout)) || Number(p.timeout) < 2 || Number(p.timeout) > 300)) throw Error('--timeout must be 2..300 seconds.');
  if (command === 'viewer-standby' && p.duration != null && (!Number.isInteger(Number(p.duration)) || Number(p.duration) < 15 || Number(p.duration) > 600)) throw Error('--duration must be 15..600 seconds.');
  return p;
}
function endpoint(env = process.env) {
  const value = env.NEXUS_BROWSER_WS || urls().websocket;
  const u = new URL(value);
  if (u.protocol !== 'ws:' || !['localhost','127.0.0.1','[::1]','::1'].includes(u.hostname) || u.pathname !== '/ws' || u.username || u.password || u.search || u.hash)
    throw Error('Terminal operator permits only a local Nexus websocket /ws.');
  return value;
}
function transact(payload, { WebSocketImpl = null, url = endpoint(), timeoutMs = 12000 } = {}) {
  WebSocketImpl ||= require('ws').WebSocket;
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    let done = false;
    function settle(err, result) {
      if (done) return;
      done = true; clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(result);
    }
    const timer = setTimeout(() => settle(Object.assign(new Error('Outcome unknown. Inspect the SAME request ID; never blindly resend.'), { code: 'DEX_TERMINAL_OUTCOME_UNKNOWN', requestId: payload.requestId })), timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'terminal-operator' }));
      ws.send(JSON.stringify(payload));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.requestId !== payload.requestId) return;
      if (msg.type === 'dex_terminal_result') settle(null, msg.result);
      else if (msg.type === 'error') settle(Object.assign(new Error(msg.message || 'Nexus rejected the request.'), { code: msg.code || 'DEX_TERMINAL_REJECTED' }));
    });
    ws.on('error', (error) => settle(error));
    ws.on('close', () => { if (!done) settle(Object.assign(new Error('Socket closed. Outcome unknown; inspect the same request ID.'), { code: 'DEX_TERMINAL_OUTCOME_UNKNOWN' })); });
  });
}
const id = () => `dex-terminal-${randomUUID()}`;
function payload(p) {
  return { requestId: p.requestId || id(), roomId: p.room,
    type: p.command === 'bootstrap' ? 'dex_terminal_bootstrap' : p.command === 'rooms' ? 'dex_terminal_rooms' : p.command === 'send' ? 'dex_terminal_room_send' : p.command === 'inspect' ? 'dex_terminal_inspect' : p.command === 'viewer-standby' ? 'dex_terminal_viewer_standby' : 'dex_terminal_check',
    ...(p.command === 'send' ? { text: p.text } : {}),
    ...(p.command === 'bootstrap' ? { roomName: p.name || 'TLO Autonomy Proof' } : {}),
    ...(p.command === 'viewer-standby' ? { durationSeconds: Number(p.duration || 300) } : {}),
    ...(p.command === 'inspect' ? { limit: Number(p.limit || 10) } : {}),
    ...(p.command === 'check' || p.command === 'wait' ? { lookupId: p.lookupId || p.requestId } : {}) };
}
async function waitFor(p, tx = transact, {
  now = () => Date.now(),
  pause = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  pollMs = WAIT_POLL_MS
} = {}) {
  if (!p.lookupId && !p.requestId) throw Error('wait requires --lookup-id EXACT_SEND_REQUEST_ID.');
  const lookupId = p.lookupId || p.requestId;
  const deadline = now() + Number(p.timeout || 195) * 1000;
  let result;
  while (now() < deadline) {
    result = await tx(payload({ ...p, command: 'check', requestId: id(), lookupId }));
    if (!result.ok || ['FINAL_RECEIPT_CONFIRMED', 'TURN_FAILED', 'TURN_OUTCOME_UNKNOWN'].includes(result.status)) return result;
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(pollMs, remaining));
  }
  return { ok: false, code: 'DEX_TERMINAL_NOT_PROVEN', message: 'No authoritative TLO final receipt before deadline. Inspect the room and existing request; do not resend.', last: result?.status };
}
async function confirmViewerStandby(result, {
  fetchImpl = globalThis.fetch,
  diagnosticsUrl = urls().diagnostics,
  timeoutMs = 6000,
  pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (!result?.ok) return result;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(diagnosticsUrl, { cache: 'no-store' });
      const data = response.ok ? await response.json() : null;
      if (data && data.dexUiConnected === false && data.viewerLease?.leaseId === result.leaseId) {
        return { ...result, headlessConfirmed: true, serverSessionId: data.serverSessionId || null };
      }
    } catch {}
    await pause(100);
  }
  return { ok: false, code: 'DEX_VIEWER_LEASE_NOT_CONFIRMED', leaseId: result.leaseId,
    message: 'Viewer standby was requested but dexUiConnected=false was not confirmed. Do not dispatch headless work.' };
}
async function tui(p, tx = transact) {
  return require('./dex-room-tui').runTui(p, { tx, payload, id, resolveIdentity: true });
}
async function main(argv = process.argv.slice(2)) {
  const p = argumentsFor(argv);
  if (p.command === 'tui') return tui(p);
  const req = payload(p);
  if (['send','bootstrap'].includes(p.command)) console.log('REQUEST_ID', req.requestId, '(preserve for recovery; do not blind-retry)');
  let result = p.command === 'wait' ? await waitFor(p) : await transact(req);
  if (p.command === 'viewer-standby') result = await confirmViewerStandby(result);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || p.command === 'wait' && result.status !== 'FINAL_RECEIPT_CONFIRMED') process.exitCode = 2;
}
if (require.main === module) main().catch(err => { console.error('DEX_TERMINAL_STOP', err.code || '', err.message); process.exitCode = 2; });
module.exports = { WAIT_POLL_MS, argumentsFor, endpoint, transact, payload, waitFor, confirmViewerStandby, tui, main };
