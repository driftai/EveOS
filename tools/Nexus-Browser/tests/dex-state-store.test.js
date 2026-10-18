const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDexStateStore } = require('../dex/state-store.js');
const { createLocalResultSweep } = require('../dex/local-tool-result-sweep.js');

test('Dex state store persists room snapshots atomically across recreation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-state-'));
  const filePath = path.join(dir, 'dex-state.json');
  const first = createDexStateStore({ filePath });
  first.save({
    rooms: [{ id: 'room-1', name: 'Durable room', updatedAt: '2026-09-18T08:00:00.000Z' }],
    activeRoomId: 'room-1',
    savedAt: '2026-09-18T08:01:00.000Z'
  });
  const second = createDexStateStore({ filePath });
  const loaded = second.load();
  assert.equal(loaded.rooms[0].name, 'Durable room');
  assert.equal(loaded.activeRoomId, 'room-1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Dex state store tolerates missing or malformed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-state-'));
  const filePath = path.join(dir, 'dex-state.json');
  fs.writeFileSync(filePath, '{bad json', 'utf8');
  assert.equal(createDexStateStore({ filePath }).load(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});


test('Dex state store applies deterministic repair before persisting a stopped room snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-state-'));
  const filePath = path.join(dir, 'dex-state.json');
  const store = createDexStateStore({ filePath });
  store.save({
    rooms: [{
      id: 'room-1', members: [{ id: 'eve' }], messages: [],
      relay: { active: false, remaining: 3, waitingFor: 'eve', lastStopReason: 'Stopped' }
    }],
    activeRoomId: 'room-1'
  });
  const loaded = createDexStateStore({ filePath });
  assert.equal(loaded.load().rooms[0].relay.remaining, 0);
  assert.equal(loaded.load().rooms[0].relay.waitingFor, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restart marks an orphaned local result claim unknown without replaying it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-state-'));
  const filePath = path.join(dir, 'dex-state.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binding = {
    targetClassId: 'local-origin',
    targetId: 'local:antigravity-existing:25032',
    providerId: 'local-antigravity-existing'
  };
  const claimed = {
    requestId: 'ctl-one', roomId: 'room-1', memberId: 'astro',
    agentMessageId: 'agent-one', turnRequestId: 'dex-turn-one',
    targetId: binding.targetId, providerId: binding.providerId,
    resultDigest: 'a'.repeat(64), text: '[DEX TOOL RESULT]\nOK',
    state: 'claimed', at: '2026-10-17T12:00:00.000Z',
    claimedAt: '2026-10-17T12:00:01.000Z', deliveryAttemptId: 'attempt-one'
  };
  const settled = { ...claimed, requestId: 'ctl-two', state: 'submitted-not-read' };
  const first = createDexStateStore({ filePath });
  const saved = first.save({
    rooms: [{
      id: 'room-1', members: [{ id: 'astro', binding }],
      messages: [{ id: 'agent-one', senderKind: 'agent', senderId: 'astro' }],
      relay: { active: false, remaining: 0, waitingFor: null },
      localToolResults: [claimed, settled]
    }],
    activeRoomId: 'room-1'
  });
  assert.equal(saved.rooms[0].localToolResults[0].state, 'claimed',
    'ordinary claim persistence must remain eligible for the first native send');

  const restarted = createDexStateStore({ filePath });
  const recovered = restarted.load().rooms[0].localToolResults;
  assert.deepEqual(recovered[0], { ...claimed, state: 'outcome-unknown' });
  assert.deepEqual(recovered[1], settled, 'unrelated terminal results retain all provenance');
  assert.deepEqual(restarted.diagnostics().repairs, [{
    roomId: 'room-1', requestId: 'ctl-one', code: 'ORPHANED_LOCAL_TOOL_RESULT_CLAIM'
  }]);

  let sends = 0;
  const sweep = createLocalResultSweep({
    load: () => restarted.load(), canWork: () => true,
    deliverOne: async () => { sends += 1; return { ok: true }; }
  });
  const result = await sweep.once();
  assert.equal(result.attempts, 0);
  assert.equal(sends, 0, 'restart uncertainty is terminal and never replay-eligible');
});
