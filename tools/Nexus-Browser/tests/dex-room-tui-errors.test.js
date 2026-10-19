'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runTui, formatRoom, formatFinal, formatRecentErrors } = require('../scripts/dex-room-tui');
const ROOM = 'room-test000001';
const FAIL = { id: 'msg-failure', senderKind: 'system', senderName: 'Dex', at: '2026-10-19T01:14:00Z',
  text: 'TLO: SEARCH_MONITOR_WORKSPACE_DISCONNECTED: Search Monitor workspace disconnected.' };
const until = async f => { const deadline = Date.now() + 1500; while (!f() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5)); assert.ok(f(), 'timed out'); };
test('room-level errors appear in terminal diagnostics without claiming exact-request proof', () => {
  const r = { ok: true, messages: [FAIL], lastStopReason: 'Relay error', busy: false, roomName: 'Proof' };
  assert.match(formatRoom(r), /last stop: Relay error/);
  assert.match(formatRecentErrors(r), /SEARCH_MONITOR_WORKSPACE_DISCONNECTED/);
  assert.match(formatRecentErrors(r), /not proof for this request/);
  assert.match(formatFinal({ status: 'TURN_FAILED', code: 'SEARCH_MONITOR_WORKSPACE_DISCONNECTED', requestId: 'req-1' }), /request req-1/);
});
test('/status and /errors only inspect: never send or replay the request', async () => {
  const input = new PassThrough(), output = new PassThrough(); let transcript = ''; const calls = [];
  output.on('data', c => transcript += String(c));
  const work = runTui({ room: ROOM }, { input, output,
    id: () => 'request-0001', payload: p => ({ type: p.command, limit: p.limit }),
    tx: async m => { calls.push(m); return { ok: true, roomName: 'Proof', lastStopReason: 'Relay error', messages: [FAIL] }; }
  });
  input.write('/status\n');
  await until(() => transcript.includes('last stop: Relay error'));
  input.write('/errors\n');
  await until(() => (transcript.match(/SEARCH_MONITOR_WORKSPACE_DISCONNECTED/g) || []).length === 2);
  input.write('/quit\n'); await work;
  assert.deepEqual(calls.map(m => m.type), ['inspect','inspect']);
  assert.ok(calls.every(m => m.limit === 20));
});
test('inactive room relay error is explicitly labeled uncertain and never resent', async () => {
  const input = new PassThrough(), output = new PassThrough(); let transcript = '', sends = 0;
  output.on('data', c => transcript += String(c));
  const work = runTui({ room: ROOM }, { input, output, pollMs: 2, timeoutMs: 400,
    id: () => 'request-0001', payload: p => ({ type: p.command, requestId: p.requestId }),
    tx: async m => m.type === 'send'
      ? (sends++, { ok: true, status: 'MESSAGE_COMMITTED_RELAY_ACCEPTED' })
      : { ok: true, status: 'AWAITING_REPLY_OR_RECOVERY', progress: 'not-active', relayActive: false,
          recoveryPending: false, lastStopReason: 'Relay error' }
  });
  input.write('ping\n');
  await until(() => transcript.includes('NOT confirmed failed or completed'));
  assert.match(transcript, /request request-0001/);
  input.write('/quit\n'); await work;
  assert.equal(sends, 1);
});