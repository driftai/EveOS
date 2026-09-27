'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const api = require('../public/dex-provider-control');
const astro = { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:25032',
  providerId: 'local-antigravity-existing' };
const eve = { targetClassId: 'online-origin', targetId: 10, providerId: 'chatgpt',
  url: 'https://chatgpt.com/c/owner' };
function controller(room) {
  const storage = { getItem: () => null, setItem: () => {} };
  return api.createController({ state: { rooms: [room], activeRoomId: room.id },
    storage, roomMessage() {}, startRelay() {}, persist() {}, renderAll() {} });
}
test('exact Astro status shows his tool receipts without unrelated member result payloads', () => {
  const room = { id: 'room-one', name: 'Eve + Astro', userName: 'Drift',
    settings: { maxTurns: 8 }, relay: { active: false },
    members: [{ id: 'astro', name: 'Astro', binding: astro },
      { id: 'eve', name: 'Eve', binding: eve }],
    localToolResults: [
      { memberId: 'astro', requestId: 'ctl-one', state: 'queued', text: 'PRIVATE-CONTROL-DATA', at: '2026-09-26' },
      { memberId: 'eve', requestId: 'ctl-eve', state: 'submitted-not-read', text: 'EVE-PRIVATE' },
      { memberId: 'astro', requestId: 'ctl-two', state: 'outcome-unknown' }
    ], localToolResultFailure: { requestId: 'ctl-three', memberId: 'astro', code: 'DEX_LOCAL_RECEIPT_BACKPRESSURE' } };
  const astroStatus = controller(room).handle({ source: astro, command: { action: 'status' } });
  assert.equal(astroStatus.ok, true);
  assert.deepEqual(astroStatus.data.localToolResults.map(e => [e.requestId, e.state]),
    [['ctl-one', 'queued'], ['ctl-two', 'outcome-unknown']]);
  assert.doesNotMatch(JSON.stringify(astroStatus.data.localToolResults), /PRIVATE-CONTROL-DATA|EVE-PRIVATE|ctl-eve/);
  assert.equal(astroStatus.data.localToolResultFailure.code, 'DEX_LOCAL_RECEIPT_BACKPRESSURE');
  const eveStatus = controller(room).handle({ source: eve, command: { action: 'status' } });
  assert.deepEqual(eveStatus.data.localToolResults.map(e => e.requestId), ['ctl-eve']);
  assert.equal(eveStatus.data.localToolResultFailure, null);
});
