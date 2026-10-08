'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect } = require('../scripts/provider-receipt-inspect');
const { parseArgs, writeProgress } = require('../scripts/provider-provenance-qualify');

test('receipt inspection reports exact IDs for every pending provider-control receipt', () => {
  const report = inspect({
    savedAt: '2026-10-08T17:00:00.000Z',
    rooms: [
      { id: 'room-idle', name: 'Idle', messages: [] },
      {
        id: 'room-c6', name: 'MS Provider Proof c05adce6', relay: { active: false, waitingFor: null },
        members: [{ id: 'member-eve', name: 'Eve-Main', binding: { targetClassId: 'online-origin', providerId: 'chatgpt', targetId: 7 } }],
        messages: [
          { id: 'msg-src', senderKind: 'user', text: 'Automated proof' },
          { id: 'msg-eve', senderKind: 'agent', senderId: 'member-eve', text: 'Qualification presence proof.\n[[DEX:CMD {"action":"quorum_presence","room":"room-c6"}]]' }
        ],
        pendingProviderControlReceipt: {
          action: 'quorum_presence', executorMemberId: 'member-eve', executorName: 'Eve-Main',
          originMessageId: 'msg-src', agentMessageId: 'msg-eve', turnRequestId: 'dex-turn-1', createdAt: '2026-10-08T17:00:00.000Z'
        }
      }
    ]
  });
  assert.equal(report.readOnly, true);
  assert.equal(report.pendingCount, 1);
  const [entry] = report.pending;
  assert.equal(entry.roomId, 'room-c6');
  assert.equal(entry.pending.turnRequestId, 'dex-turn-1');
  assert.equal(entry.executor.id, 'member-eve');
  assert.equal(entry.capturedCommand, '{"action":"quorum_presence","room":"room-c6"}');
  assert.equal(entry.originMessage.id, 'msg-src');
  assert.equal(entry.roomState.relayActive, false);
});

test('provider qualifier preserves rooms unless deletion is explicitly allowed', () => {
  assert.equal(parseArgs([]).allowRoomDelete, false);
  assert.equal(parseArgs(['--allow-room-delete']).allowRoomDelete, true);
});

test('provider qualifier persists progress so a hard kill keeps room and control IDs', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-progress-')), 'progress.txt');
  writeProgress({ roomId: 'room-x', controls: [{ requestId: 'qualify-control-1', action: 'send', outcome: 'pending' }] }, 'awaiting-receipt:quorum_presence', file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.phase, 'awaiting-receipt:quorum_presence');
  assert.equal(saved.evidence.roomId, 'room-x');
  assert.equal(saved.evidence.controls[0].requestId, 'qualify-control-1');
});
