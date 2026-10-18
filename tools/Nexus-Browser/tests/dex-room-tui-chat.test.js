'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runTui, formatRoom, formatFinal } = require('../scripts/dex-room-tui');

test('default chat formatting shows the reply, not a JSON send receipt', () => {
  assert.equal(formatFinal({ status: 'FINAL_RECEIPT_CONFIRMED', response: { text: 'Hello, I am TLO.' } }), 'TLO/Dex> Hello, I am TLO.');
  assert.match(formatRoom({ ok: true, roomName: 'Proof', busy: false, tloMemberId: 'tlo', machineSpaceId: 'space' }), /idle · TLO bound · Machine Space attached/);
});

test('TUI prints confirmed reply automatically; raw receipt appears only after /details', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let display = ''; output.on('data', c => { display += String(c); });
  let request = 0, sends = 0, checks = 0;
  const task = runTui({ room: 'room-test123456' }, {
    input, output, pollMs: 2, timeoutMs: 500,
    id: () => 'tui-request-' + (++request),
    payload: p => ({ type: p.command, requestId: p.requestId, lookupId: p.lookupId, text: p.text }),
    tx: async msg => {
      if (msg.type === 'send') { sends++; return { ok: true, requestId: msg.requestId, status: 'MESSAGE_COMMITTED_RELAY_ACCEPTED', deliveryConfirmed: false, sensitiveReceiptField: 'hidden by default' }; }
      if (msg.type === 'check') { checks++; return { ok: true, status: 'FINAL_RECEIPT_CONFIRMED', finalRequestId: 'turn-1', response: { text: 'Hello! Your Dex message arrived.' } }; }
      return { ok: true, roomName: 'Proof' };
    }
  });
  input.write('hello?\n');
  const timeout = Date.now() + 1500;
  while (!display.includes('Hello! Your Dex message arrived.') && Date.now() < timeout) await new Promise(r => setTimeout(r, 5));
  assert.match(display, /TLO\/Dex> Hello! Your Dex message arrived/);
  assert.doesNotMatch(display, /sensitiveReceiptField/);
  input.write('/details\n');
  const end = Date.now() + 1500;
  while (!display.includes('sensitiveReceiptField') && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  input.write('/quit\n');
  await task;
  assert.match(display, /sensitiveReceiptField/);
  assert.equal(sends, 1);
  assert.ok(checks >= 1);
});

test('a rejected send never triggers a background check or duplicate send', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let transcript = ''; output.on('data', c => { transcript += String(c); });
  const calls = [];
  const task = runTui({ room: 'room-test123456' }, {
    input, output, id: () => 'tui-request-1',
    payload: p => ({ type: p.command, requestId: p.requestId }),
    tx: async msg => { calls.push(msg.type); return { ok: false, code: 'DEX_TERMINAL_ROOM_BUSY', message: 'Existing turn underway.' }; }
  });
  input.write('hello\n');
  const timeout = Date.now() + 1500;
  while (!transcript.includes('DEX_TERMINAL_ROOM_BUSY') && Date.now() < timeout) await new Promise(r => setTimeout(r, 5));
  input.write('/quit\n'); await task;
  assert.deepEqual(calls, ['send']);
});
