'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { formatRooms, chooseRoom, runApp } = require('../scripts/dex-tui');
const ROOM_A = 'room-first000001', ROOM_B = 'room-second00002';
const sample = (roomId, roomName) => ({ roomId, roomName, busy: false,
  recoveryPending: false, tloMemberId: 'agent-tlo', machineSpaceId: 'space-test' });
const waitFor = async (condition) => {
  const deadline = Date.now() + 1500;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), 'expected console state did not appear');
};
function session({ responses, runRoom } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  let display = ''; output.on('data', chunk => { display += String(chunk); });
  const calls = [];
  const task = runApp({ input, output,
    id: () => `dex-test-${calls.length + 1000}`,
    makePayload: p => ({ type: p.command, requestId: p.requestId }),
    tx: async msg => { calls.push(msg); return typeof responses === 'function' ? responses(calls.length) : responses[calls.length - 1]; },
    runRoom: runRoom || (async () => {})
  });
  return { input, output, calls, task, display: () => display };
}
test('picker formats bounded names without terminal control injection', () => {
  const text = formatRooms([sample(ROOM_A, 'Safe\x1b[31m\nInjected')]);
  assert.match(text, /1\. Safe \[31m Injected/);
  assert.doesNotMatch(text, /\x1b|\nInjected/);
  assert.match(text, /idle, TLO, Machine Space/);
  assert.equal(chooseRoom('1', [sample(ROOM_A, 'A')]).roomId, ROOM_A);
  assert.equal(chooseRoom(ROOM_A, [sample(ROOM_A, 'A')]).roomId, ROOM_A);
  assert.equal(chooseRoom('0', [sample(ROOM_A, 'A')]), null);
  assert.equal(chooseRoom('A', [sample(ROOM_A, 'A')]), null);
});
test('selecting numbered room delegates to established chat without sending a request', async () => {
  let opened;
  const s = session({ responses: [{ ok: true, rooms: [sample(ROOM_A, 'Alpha'), sample(ROOM_B, 'Beta')] }],
    runRoom: async (p, opts) => { opened = { p, opts }; } });
  await waitFor(() => s.display().includes('dex-tui> '));
  s.input.write('2\n');
  const result = await s.task;
  assert.deepEqual(s.calls.map(c => c.type), ['rooms']);
  assert.equal(result.roomId, ROOM_B);
  assert.equal(opened.p.room, ROOM_B);
  assert.equal(typeof opened.opts.tx, 'function');
  assert.equal(typeof opened.opts.payload, 'function');
});
test('failed refresh invalidates old room selection; next successful refresh restores picker', async () => {
  let opened;
  const s = session({ responses: [
    { ok: true, rooms: [sample(ROOM_A, 'Alpha')] },
    { ok: false, code: 'DISCONNECTED', message: 'offline' },
    { ok: true, rooms: [sample(ROOM_B, 'Beta')] }
  ], runRoom: async p => { opened = p.room; } });
  await waitFor(() => s.display().includes('dex-tui> '));
  s.input.write('/refresh\n');
  await waitFor(() => s.display().includes('DISCONNECTED'));
  s.input.write('1\n');
  await waitFor(() => s.display().includes('No matching listed room'));
  s.input.write('/refresh\n');
  await waitFor(() => s.display().includes(ROOM_B));
  s.input.write(`${ROOM_B}\n`);
  await s.task;
  assert.equal(opened, ROOM_B);
  assert.deepEqual(s.calls.map(c => c.type), ['rooms', 'rooms', 'rooms']);
});
test('invalid room IDs and quit perform discovery only, not chat or dispatch', async () => {
  let opened = false;
  const s = session({ responses: [{ ok: true, rooms: [sample(ROOM_A, 'Alpha'), { roomId: 'not-room', roomName: 'Bad' }] }],
    runRoom: async () => { opened = true; } });
  await waitFor(() => s.display().includes('dex-tui> '));
  s.input.write('not-room\n');
  await waitFor(() => s.display().includes('No matching listed room'));
  s.input.write('/quit\n');
  const result = await s.task;
  assert.equal(result.quit, true);
  assert.equal(opened, false);
  assert.deepEqual(s.calls.map(c => c.type), ['rooms']);
});
