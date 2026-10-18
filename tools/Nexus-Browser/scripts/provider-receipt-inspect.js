#!/usr/bin/env node
'use strict';

// Read-only: lists every room holding a pendingProviderControlReceipt with the
// exact IDs needed to correlate it. Never sends, retries, or mutates anything.
const fs = require('node:fs');
const path = require('node:path');
const { dataDir } = require('../runtime-config');

const CMD_RE = /\[\[DEX:CMD\s+(\{[\s\S]*?\})\]\]\s*$/;

function clip(text, max = 160) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function messageSummary(value = {}) {
  const message = record(value);
  return {
    id: message.id || null,
    senderKind: message.senderKind || null,
    senderId: message.senderId || null,
    senderName: message.senderName || null,
    at: message.at || null,
    requestId: message.requestId || message.turnRequestId || null,
    controlReceipt: message.controlReceipt || null,
    text: clip(message.text)
  };
}

function inspectRoom(value = {}, { now = Date.now() } = {}) {
  const room = record(value);
  const pending = record(room.pendingProviderControlReceipt);
  const messages = Array.isArray(room.messages) ? room.messages : [];
  const byId = (id) => messages.find((entry) => entry?.id === id) || null;
  const agentMessage = byId(pending.agentMessageId);
  const originMessage = byId(pending.originMessageId);
  const cmd = String(agentMessage?.text || '').match(CMD_RE)?.[1] || null;
  const receipts = messages.filter((entry) => entry?.controlReceipt).map((entry) => ({
    id: entry.id, at: entry.at || null, ...record(entry.controlReceipt)
  }));
  const pendingTime = Date.parse(pending.createdAt || '');
  const ageMs = Number.isFinite(pendingTime) ? now - pendingTime : null;
  return {
    roomId: room.id || null,
    roomName: room.name || null,
    disposable: room.disposable === true,
    pending,
    ageMinutes: ageMs == null ? null : Math.round(ageMs / 60000),
    executor: (Array.isArray(room.members) ? room.members : []).filter((m) => m?.id === pending.executorMemberId)
      .map((m) => ({ id: m.id, name: m.name, binding: m.binding || null }))[0] || null,
    capturedCommand: cmd,
    agentMessage: agentMessage ? messageSummary(agentMessage) : null,
    originMessage: originMessage ? messageSummary(originMessage) : null,
    roomState: {
      relayActive: !!room.relay?.active,
      waitingFor: room.relay?.waitingFor || null,
      pendingTurn: room.pendingTurn ? { requestId: room.pendingTurn.requestId || null, memberId: room.pendingTurn.memberId || null } : null,
      recovery: room.recovery ? { requestId: room.recovery.requestId || null, memberId: room.recovery.memberId || null, passiveAt: room.recovery.passiveAt || null } : null,
      deferredRelays: Array.isArray(room.deferredRelays) ? room.deferredRelays.length : 0,
      messageCount: messages.length,
      localToolResultFailure: room.localToolResultFailure || null
    },
    receiptsInRoom: receipts,
    lastMessages: messages.slice(-4).map(messageSummary)
  };
}

function inspect(value = {}, options = {}) {
  const snapshot = record(value);
  const rooms = Array.isArray(snapshot.rooms) ? snapshot.rooms : [];
  const pending = rooms.filter((room) => room?.pendingProviderControlReceipt)
    .map((room) => inspectRoom(room, options));
  return { kind: 'provider-control-receipt-inspection', readOnly: true, savedAt: snapshot.savedAt || null, rooms: rooms.length, pendingCount: pending.length, pending };
}

const SAFE_ACTIONS = new Set([
  'quorum_presence', 'quorum_open',
  'quorum_vote', 'quorum_close',
]);
const LIVE_STATUSES = new Set(['NOT_CHECKED', 'UNAVAILABLE', 'AVAILABLE']);
const MAX_ID_LENGTH = 220;
const STALE_AFTER_MS = 5 * 60 * 1000;

function safeIdentifier(value) {
  if (typeof value !== 'string') return null;
  const text = value;
  if (!text || text.length > MAX_ID_LENGTH) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(text) ? text : null;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return null;
  const parsed = Date.parse(value);
  const canonical = `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical
    ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function timeEvidence(value, now) {
  const timestamp = safeTimestamp(value);
  if (!timestamp) {
    return { timestamp: null, ageMs: null, ageMinutes: null, state: 'MISSING_OR_INVALID' };
  }
  const ageMs = now - Date.parse(timestamp);
  if (ageMs < 0) {
    return { timestamp, ageMs, ageMinutes: null, state: 'FUTURE_CLOCK_SKEW' };
  }
  return {
    timestamp,
    ageMs,
    ageMinutes: Math.floor(ageMs / 60000),
    state: 'VALID',
  };
}

function receiptCorrelates(receiptValue, pending, pendingTime) {
  const receipt = record(receiptValue);
  const receiptTimestamp = safeTimestamp(receipt.at);
  return Boolean(
    SAFE_ACTIONS.has(pending.action)
    && pending.turnRequestId
    && pending.executorMemberId
    && pending.originMessageId
    && safeIdentifier(receipt.requestId) === pending.turnRequestId
    && receipt.action === pending.action
    && safeIdentifier(receipt.executorMemberId) === pending.executorMemberId
    && safeIdentifier(receipt.originMessageId) === pending.originMessageId
    && pendingTime != null
    && receiptTimestamp
    && Date.parse(receiptTimestamp) >= pendingTime
  );
}

function summarize(value, { now = Date.now(), liveStatus = 'NOT_CHECKED' } = {}) {
  const report = record(value);
  const currentTime = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const snapshotTime = timeEvidence(report.savedAt, currentTime);
  const entries = Array.isArray(report.pending)
    ? report.pending.filter((entry) => Object.keys(record(entry)).length) : [];
  const pending = entries.map((entryValue) => {
    const entry = record(entryValue);
    const state = record(entry.roomState);
    const pendingValue = record(entry.pending);
    const actionValid = SAFE_ACTIONS.has(pendingValue.action);
    const action = actionValid ? pendingValue.action : 'other';
    const roomId = safeIdentifier(entry.roomId);
    const turnRequestId = safeIdentifier(pendingValue.turnRequestId);
    const executorMemberId = safeIdentifier(pendingValue.executorMemberId);
    const originMessageId = safeIdentifier(pendingValue.originMessageId);
    const pendingTimestamp = timeEvidence(pendingValue.createdAt, currentTime);
    const normalizedPending = {
      action: actionValid ? action : null,
      turnRequestId, executorMemberId, originMessageId,
    };
    const receipts = Array.isArray(entry.receiptsInRoom) ? entry.receiptsInRoom : [];
    const correlatedReceiptCount = receipts.filter((receipt) => receiptCorrelates(
      receipt,
      normalizedPending,
      pendingTimestamp.timestamp ? Date.parse(pendingTimestamp.timestamp) : null
    )).length;
    const receiptCount = receipts.length;
    const active = state.relayActive === true
      || Boolean(state.waitingFor)
      || Boolean(state.pendingTurn)
      || Boolean(state.recovery)
      || safeCount(state.deferredRelays) > 0;

    return {
      roomId,
      disposable: entry.disposable === true,
      action,
      turnRequestId,
      identifiersValid: Boolean(roomId && turnRequestId),
      correlationKeysValid: Boolean(
        turnRequestId && executorMemberId && originMessageId
      ),
      ageMinutes: pendingTimestamp.ageMinutes,
      pendingTimeState: pendingTimestamp.state,
      relayActive: state.relayActive === true,
      recoveryActive: Boolean(state.recovery),
      deferredRelays: safeCount(state.deferredRelays),
      receiptCount,
      correlatedReceiptCount,
      uncorrelatedReceiptCount: receiptCount - correlatedReceiptCount,
      reviewState: correlatedReceiptCount
        ? 'LATER_CORRELATED_RECEIPT_REVIEW_REQUIRED'
        : receiptCount
          ? 'RECEIPT_CORRELATION_REQUIRED'
          : active
            ? 'ACTIVE_PENDING_UNCERTAIN'
            : 'QUIESCENT_PENDING_UNCERTAIN',
      disposition: 'UNRESOLVED',
    };
  });

  const normalizedLiveStatus = LIVE_STATUSES.has(liveStatus)
    ? liveStatus : 'NOT_CHECKED';
  return {
    kind: 'provider-control-receipt-summary',
    readOnly: true,
    authority: 'saved-snapshot-only',
    liveStatus: normalizedLiveStatus,
    liveStatusAuthority: normalizedLiveStatus === 'NOT_CHECKED'
      ? 'not-checked' : 'caller-supplied-read-only-observation',
    savedAt: snapshotTime.timestamp,
    snapshotAgeMinutes: snapshotTime.ageMinutes,
    snapshotTimeState: snapshotTime.state,
    snapshotMayBeStale:
      snapshotTime.state !== 'VALID' || snapshotTime.ageMs > STALE_AFTER_MS,
    rooms: safeCount(report.rooms),
    pendingCount: pending.length,
    pending,
    nextAction: 'CORRELATE_LIVE_AUTHORITY_BEFORE_DISPOSITION',
  };
}

function renderSummary(summary) {
  return 'PROVIDER_RECEIPT_SUMMARY_BEGIN\n'
    + JSON.stringify(summary)
    + '\nPROVIDER_RECEIPT_SUMMARY_END\n';
}

function main(argv = process.argv.slice(2)) {
  const fileArg = argv.indexOf('--state-file');
  const file = fileArg >= 0 ? argv[fileArg + 1] : path.join(dataDir(), 'dex-state.json');
  const progressFile = path.join(__dirname, '..', 'machine-spaces-provider-progress.txt');
  const report = inspect(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (argv.includes('--summary')) {
    const liveArg = argv.indexOf('--live-status');
    const compact = summarize(report, {
      liveStatus: liveArg >= 0 ? argv[liveArg + 1] : 'NOT_CHECKED',
    });
    process.stdout.write(renderSummary(compact));
    return;
  }
  report.stateFile = file;
  try { report.lastQualifierProgress = JSON.parse(fs.readFileSync(progressFile, 'utf8')); } catch { report.lastQualifierProgress = null; }
  process.stdout.write('PROVIDER_RECEIPT_INSPECTION_BEGIN\n' + JSON.stringify(report, null, 2) + '\nPROVIDER_RECEIPT_INSPECTION_END\n');
}

if (require.main === module) main();

module.exports = { inspect, inspectRoom, summarize, renderSummary };
