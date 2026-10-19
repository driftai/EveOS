'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runTui } = require('../scripts/dex-room-tui');
const ROOM = 'room-preview-test';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await sleep(5);
  assert.ok(check(), 'Timed out waiting for terminal output');
}
function makeIO() {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += String(chunk); });
  return { input, output, transcript: () => text };
}

test('preview commands are terminal-only; default is OFF and invalid settings never send', async () => {
  const io = makeIO(), calls = [];
  const task = runTui({ room: ROOM }, {
    input: io.input, output: io.output,
    id: () => 'request-preview',
    payload: p => ({ type: p.command }),
    tx: async msg => { calls.push(msg.type); return { ok: true }; }
  });
  io.input.write('/preview\n');
  await until(() => io.transcript().includes('Live preview OFF'));
  io.input.write('/preview on\n');
  await until(() => io.transcript().includes('Live preview ON'));
  io.input.write('/preview invalid\n');
  await until(() => io.transcript().includes('Usage: /preview [on|off]'));
  io.input.write('/preview off\n');
  await until(() => io.transcript().match(/Live preview OFF/g)?.length === 2);
  io.input.write('/quit\n');
  await task;
  assert.deepEqual(calls, []);
});

test('live preview stays OFF by default; final receipt and progress still appear', async () => {
  const io = makeIO(); let sends = 0, checks = 0;
  const task = runTui({ room: ROOM }, {
    input: io.input, output: io.output, pollMs: 3, timeoutMs: 1800,
    id: () => 'request-preview',
    payload: p => ({ type: p.command }),
    tx: async msg => {
      if (msg.type === 'send') { sends++; return { ok: true, status: 'MESSAGE_COMMITTED_RELAY_ACCEPTED' }; }
      if (msg.type === 'check') {
        checks++;
        if (checks < 3) return { ok: true, status: 'AWAITING_REPLY_OR_RECOVERY', progress: 'generating', partialText: 'Secret partial text' };
        return { ok: true, status: 'FINAL_RECEIPT_CONFIRMED', response: { text: 'Confirmed final text' } };
      }
      throw Error('Unexpected transport command: ' + msg.type);
    }
  });
  io.input.write('hello\n');
  await until(() => io.transcript().includes('TLO/Dex> Confirmed final text'));
  io.input.write('/quit\n'); await task;
  assert.equal(sends, 1);
  assert.ok(checks >= 3);
  assert.match(io.transcript(), /generating/);
  assert.doesNotMatch(io.transcript(), /Secret partial text|live preview>/);
});

test('preview can turn ON and OFF during an active turn without replay or losing final', async () => {
  const io = makeIO(); let sends = 0, checks = 0, done = false;
  let partial = 'Partial before enabling';
  const task = runTui({ room: ROOM }, {
    input: io.input, output: io.output, pollMs: 4, timeoutMs: 2000,
    id: () => 'request-preview',
    payload: p => ({ type: p.command }),
    tx: async msg => {
      if (msg.type === 'send') { sends++; return { ok: true, status: 'MESSAGE_COMMITTED_RELAY_ACCEPTED' }; }
      if (msg.type === 'check') {
        checks++;
        return done
          ? { ok: true, status: 'FINAL_RECEIPT_CONFIRMED', response: { text: 'The authoritative final' } }
          : { ok: true, status: 'AWAITING_REPLY_OR_RECOVERY', progress: 'generating', partialText: partial };
      }
      throw Error('Unexpected transport command: ' + msg.type);
    }
  });
  io.input.write('hello\n');
  await until(() => checks >= 2);
  assert.doesNotMatch(io.transcript(), /TLO \(live preview\)>/);
  io.input.write('/preview on\n');
  await until(() => io.transcript().includes('TLO (live preview)> Partial before enabling'));
  io.input.write('/preview off\n');
  await until(() => io.transcript().includes('Live preview OFF'));
  const before = checks;
  partial = 'Partial after disabling';
  await until(() => checks >= before + 3);
  assert.doesNotMatch(io.transcript(), /Partial after disabling/);
  done = true;
  await until(() => io.transcript().includes('TLO/Dex> The authoritative final'));
  io.input.write('/quit\n'); await task;
  assert.equal(sends, 1);
  assert.equal((io.transcript().match(/TLO\/Dex> The authoritative final/g) || []).length, 1);
});