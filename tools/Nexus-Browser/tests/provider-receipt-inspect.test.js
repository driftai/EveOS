'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect, summarize, renderSummary } = require('../scripts/provider-receipt-inspect');
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

test('compact summary keeps quiet pending requests unresolved', () => {
  const report = inspect({
    savedAt: '2026-10-12T22:57:07.649Z',
    rooms: [{
      id: 'room-one',
      disposable: true,
      relay: { active: false },
      messages: [{
        id: 'msg-one',
        text: 'PRIVATE_MESSAGE_CANARY',
      }],
      pendingProviderControlReceipt: {
        action: 'quorum_presence',
        agentMessageId: 'msg-one',
        turnRequestId: 'dex-turn-one',
        createdAt: '2026-10-08T17:00:00.000Z',
      },
    }],
  });

  const summary = summarize(report, {
    now: Date.parse('2026-10-17T20:29:00Z'),
  });

  assert.equal(summary.readOnly, true);
  assert.equal(summary.authority, 'saved-snapshot-only');
  assert.equal(summary.snapshotMayBeStale, true);
  assert.equal(summary.pendingCount, 1);
  assert.equal(
    summary.pending[0].reviewState,
    'QUIESCENT_PENDING_UNCERTAIN'
  );
  assert.equal(summary.pending[0].disposition, 'UNRESOLVED');
  assert.equal(
    JSON.stringify(summary).includes('PRIVATE_MESSAGE_CANARY'),
    false
  );
});

test('active requests and room receipts still require correlation', () => {
  const entry = {
    roomId: 'room-two',
    disposable: true,
    pending: {
      action: 'quorum_vote',
      turnRequestId: 'dex-turn-two',
    },
    ageMinutes: 100,
    capturedCommand: 'PRIVATE_COMMAND_CANARY',
    roomState: {
      relayActive: true,
      deferredRelays: 0,
    },
    receiptsInRoom: [],
  };

  const report = {
    savedAt: '2026-10-12T22:57:07.649Z',
    rooms: 1,
    pendingCount: 1,
    pending: [entry],
  };

  let summary = summarize(report);
  assert.equal(
    summary.pending[0].reviewState,
    'ACTIVE_PENDING_UNCERTAIN'
  );

  entry.receiptsInRoom = [{
    controlReceipt: { secret: 'PRIVATE_RECEIPT_CANARY' },
  }];

  summary = summarize(report);
  assert.equal(
    summary.pending[0].reviewState,
    'RECEIPT_CORRELATION_REQUIRED'
  );
  assert.equal(summary.pending[0].disposition, 'UNRESOLVED');

  const output = JSON.stringify(summary);
  assert.equal(output.includes('PRIVATE_COMMAND_CANARY'), false);
  assert.equal(output.includes('PRIVATE_RECEIPT_CANARY'), false);
});

test('snapshot staleness uses the raw five-minute boundary and exposes clock state', () => {
  const savedAt = '2026-10-17T20:00:00.000Z';
  const report = { savedAt, rooms: 0, pending: [] };
  const exact = summarize(report, { now: Date.parse(savedAt) + 300000 });
  const stale = summarize(report, { now: Date.parse(savedAt) + 300001 });
  const skewed = summarize(report, { now: Date.parse(savedAt) - 1 });
  const invalid = summarize({ savedAt: 'not-a-time', pending: [] });

  assert.equal(exact.snapshotAgeMinutes, 5);
  assert.equal(exact.snapshotMayBeStale, false);
  assert.equal(stale.snapshotAgeMinutes, 5);
  assert.equal(stale.snapshotMayBeStale, true);
  assert.equal(skewed.snapshotTimeState, 'FUTURE_CLOCK_SKEW');
  assert.equal(skewed.snapshotMayBeStale, true);
  assert.equal(invalid.savedAt, null);
  assert.equal(invalid.snapshotTimeState, 'MISSING_OR_INVALID');
});

test('summary rejects malformed identifiers and remains bounded and deterministic', () => {
  const privateCanary = 'PRIVATE_PROVIDER_CANARY';
  const report = {
    savedAt: { canary: privateCanary },
    rooms: 'many',
    pendingCount: 99,
    pending: [null, {
      roomId: 'room-' + 'x'.repeat(50000),
      pending: {
        action: 'quorum_presence',
        turnRequestId: { canary: privateCanary },
        createdAt: '2026-10-17T20:00:00.000Z',
      },
      roomState: { deferredRelays: 'not-a-count' },
      receiptsInRoom: [],
    }],
  };

  const summary = summarize(report, {
    now: Date.parse('2026-10-17T20:10:00.000Z'),
  });
  const output = JSON.stringify(summary);

  assert.equal(summary.rooms, 0);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.pending[0].roomId, null);
  assert.equal(summary.pending[0].turnRequestId, null);
  assert.equal(summary.pending[0].identifiersValid, false);
  assert.equal(summary.pending[0].ageMinutes, 10);
  assert.equal(summary.pending[0].deferredRelays, 0);
  assert.equal(output.includes(privateCanary), false);
  assert.ok(output.length < 2000);

  const empty = summarize(null, { now: Date.parse('2026-10-17T20:10:00.000Z') });
  const nullPending = summarize({ pending: null }, { now: Date.parse('2026-10-17T20:10:00.000Z') });
  assert.equal(empty.pendingCount, 0);
  assert.deepEqual(nullPending.pending, []);
});

test('inspection time injection and pending timestamp states are deterministic', () => {
  const createdAt = '2026-10-17T20:00:00.000Z';
  const room = {
    id: 'room-clock', messages: [], roomState: {},
    pendingProviderControlReceipt: {
      action: 'quorum_open', turnRequestId: 'dex-turn-clock', createdAt,
    },
  };
  const early = inspect({ rooms: [room] }, { now: Date.parse(createdAt) + 60000 });
  const late = inspect({ rooms: [room] }, { now: Date.parse(createdAt) + 120000 });
  assert.equal(early.pending[0].ageMinutes, 1);
  assert.equal(late.pending[0].ageMinutes, 2);

  const entries = [undefined, '2026-10-17T20:11:00.000Z'].map((timestamp, index) => ({
    roomId: `room-time-${index}`,
    pending: {
      action: 'quorum_open', turnRequestId: `dex-turn-time-${index}`,
      createdAt: timestamp,
    },
    roomState: {}, receiptsInRoom: [],
  }));
  const summary = summarize({ pending: entries }, {
    now: Date.parse('2026-10-17T20:10:00.000Z'),
  });
  assert.equal(summary.pending[0].pendingTimeState, 'MISSING_OR_INVALID');
  assert.equal(summary.pending[1].pendingTimeState, 'FUTURE_CLOCK_SKEW');
  assert.ok(summary.pending.every((entry) => entry.disposition === 'UNRESOLVED'));
});

test('later exact receipt evidence is distinguished from mismatched request IDs', () => {
  const entry = {
    roomId: 'room-correlation',
    pending: {
      action: 'quorum_vote',
      turnRequestId: 'dex-turn-correlation',
      executorMemberId: 'member-correlation',
      originMessageId: 'msg-origin-correlation',
      createdAt: '2026-10-17T20:00:00.000Z',
    },
    roomState: {},
    receiptsInRoom: [{
      requestId: 'dex-turn-other',
      action: 'quorum_vote',
      executorMemberId: 'member-correlation',
      originMessageId: 'msg-origin-correlation',
      at: '2026-10-17T20:01:00.000Z',
      secret: 'PRIVATE_RECEIPT_CANARY',
    }, {
      requestId: 'dex-turn-correlation',
      action: 'quorum_vote',
      executorMemberId: 'member-wrong',
      originMessageId: 'msg-origin-correlation',
      at: '2026-10-17T20:01:10.000Z',
    }],
  };
  const options = { now: Date.parse('2026-10-17T20:02:00.000Z') };

  let summary = summarize({ savedAt: '2026-10-17T20:00:00.000Z', rooms: 1, pending: [entry] }, options);
  assert.equal(summary.pending[0].correlatedReceiptCount, 0);
  assert.equal(summary.pending[0].uncorrelatedReceiptCount, 2);
  assert.equal(summary.pending[0].reviewState, 'RECEIPT_CORRELATION_REQUIRED');
  assert.equal(summary.pending[0].disposition, 'UNRESOLVED');

  entry.receiptsInRoom.push({
    requestId: 'dex-turn-correlation',
    action: 'quorum_vote',
    executorMemberId: 'member-correlation',
    originMessageId: 'msg-origin-correlation',
    at: '2026-10-17T20:01:30.000Z',
  });
  summary = summarize({ savedAt: '2026-10-17T20:00:00.000Z', rooms: 1, pending: [entry] }, options);
  assert.equal(summary.pending[0].correlatedReceiptCount, 1);
  assert.equal(summary.pending[0].reviewState, 'LATER_CORRELATED_RECEIPT_REVIEW_REQUIRED');
  assert.equal(JSON.stringify(summary).includes('PRIVATE_RECEIPT_CANARY'), false);
});

test('correlation rejects normalized identifiers, invalid actions, and invalid dates', () => {
  const pending = {
    action: 'quorum_vote',
    turnRequestId: 'dex-turn-exact',
    executorMemberId: 'member-exact',
    originMessageId: 'msg-exact',
    createdAt: '2026-10-17T20:00:00.000Z',
  };
  const receipt = {
    requestId: ' dex-turn-exact ',
    action: 'quorum_vote',
    executorMemberId: 'member-exact',
    originMessageId: 'msg-exact',
    at: '2026-10-17T20:01:00.000Z',
  };
  const report = {
    savedAt: '2026-02-30T00:00:00.000Z',
    pending: [{ roomId: 'room-exact', pending, roomState: {}, receiptsInRoom: [receipt] }],
  };
  const options = { now: Date.parse('2026-10-17T20:02:00.000Z') };

  let summary = summarize(report, options);
  assert.equal(summary.snapshotTimeState, 'MISSING_OR_INVALID');
  assert.equal(summary.pending[0].correlatedReceiptCount, 0);

  report.pending[0].pending = { ...pending, action: 'not-allowlisted' };
  report.pending[0].receiptsInRoom = [{ ...receipt, requestId: pending.turnRequestId, action: 'other' }];
  summary = summarize(report, options);
  assert.equal(summary.pending[0].action, 'other');
  assert.equal(summary.pending[0].correlatedReceiptCount, 0);
});

test('invalid live status is reported as not checked without caller authority', () => {
  const summary = summarize({ pending: [] }, { liveStatus: 'BAD_STATUS' });
  assert.equal(summary.liveStatus, 'NOT_CHECKED');
  assert.equal(summary.liveStatusAuthority, 'not-checked');
});

test('multiple and empty pending summaries are stable and compact output stays three lines', () => {
  const entries = ['one', 'two'].map((suffix) => ({
    roomId: `room-${suffix}`,
    pending: {
      action: 'quorum_open',
      turnRequestId: `dex-turn-${suffix}`,
      createdAt: '2026-10-17T20:00:00.000Z',
    },
    roomState: {},
    receiptsInRoom: [],
  }));
  const options = {
    now: Date.parse('2026-10-17T20:03:00.000Z'),
    liveStatus: 'UNAVAILABLE',
  };
  const multiple = summarize({ savedAt: '2026-10-17T20:00:00.000Z', rooms: 2, pending: entries }, options);
  const empty = summarize({ savedAt: '2026-10-17T20:00:00.000Z', rooms: 2, pending: [] }, options);

  assert.equal(multiple.pendingCount, 2);
  assert.ok(multiple.pending.every((entry) => entry.disposition === 'UNRESOLVED'));
  assert.equal(multiple.liveStatus, 'UNAVAILABLE');
  assert.equal(
    multiple.liveStatusAuthority,
    'caller-supplied-read-only-observation'
  );
  assert.equal(empty.pendingCount, 0);
  assert.deepEqual(empty.pending, []);
  assert.equal(renderSummary(multiple).trim().split(/\r?\n/).length, 3);
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
