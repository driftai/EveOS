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

function messageSummary(message = {}) {
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

function inspectRoom(room = {}) {
  const pending = room.pendingProviderControlReceipt;
  const messages = Array.isArray(room.messages) ? room.messages : [];
  const byId = (id) => messages.find((entry) => entry.id === id) || null;
  const agentMessage = byId(pending.agentMessageId);
  const originMessage = byId(pending.originMessageId);
  const cmd = String(agentMessage?.text || '').match(CMD_RE)?.[1] || null;
  const receipts = messages.filter((entry) => entry.controlReceipt).map((entry) => ({
    id: entry.id, at: entry.at || null, ...entry.controlReceipt
  }));
  const ageMs = Date.parse(pending.createdAt || '') ? Date.now() - Date.parse(pending.createdAt) : null;
  return {
    roomId: room.id || null,
    roomName: room.name || null,
    disposable: room.disposable === true,
    pending,
    ageMinutes: ageMs == null ? null : Math.round(ageMs / 60000),
    executor: (room.members || []).filter((m) => m.id === pending.executorMemberId)
      .map((m) => ({ id: m.id, name: m.name, binding: m.binding || null }))[0] || null,
    capturedCommand: cmd,
    agentMessage: agentMessage ? messageSummary(agentMessage) : null,
    originMessage: originMessage ? messageSummary(originMessage) : null,
    roomState: {
      relayActive: !!room.relay?.active,
      waitingFor: room.relay?.waitingFor || null,
      pendingTurn: room.pendingTurn ? { requestId: room.pendingTurn.requestId || null, memberId: room.pendingTurn.memberId || null } : null,
      recovery: room.recovery ? { requestId: room.recovery.requestId || null, memberId: room.recovery.memberId || null, passiveAt: room.recovery.passiveAt || null } : null,
      deferredRelays: (room.deferredRelays || []).length,
      messageCount: messages.length,
      localToolResultFailure: room.localToolResultFailure || null
    },
    receiptsInRoom: receipts,
    lastMessages: messages.slice(-4).map(messageSummary)
  };
}

function inspect(snapshot = {}) {
  const rooms = Array.isArray(snapshot.rooms) ? snapshot.rooms : [];
  const pending = rooms.filter((room) => room && room.pendingProviderControlReceipt).map(inspectRoom);
  return { kind: 'provider-control-receipt-inspection', readOnly: true, savedAt: snapshot.savedAt || null, rooms: rooms.length, pendingCount: pending.length, pending };
}

function main(argv = process.argv.slice(2)) {
  const fileArg = argv.indexOf('--state-file');
  const file = fileArg >= 0 ? argv[fileArg + 1] : path.join(dataDir(), 'dex-state.json');
  const progressFile = path.join(__dirname, '..', 'machine-spaces-provider-progress.txt');
  const report = inspect(JSON.parse(fs.readFileSync(file, 'utf8')));
  report.stateFile = file;
  try { report.lastQualifierProgress = JSON.parse(fs.readFileSync(progressFile, 'utf8')); } catch { report.lastQualifierProgress = null; }
  process.stdout.write('PROVIDER_RECEIPT_INSPECTION_BEGIN\n' + JSON.stringify(report, null, 2) + '\nPROVIDER_RECEIPT_INSPECTION_END\n');
}

if (require.main === module) main();

module.exports = { inspect, inspectRoom };
