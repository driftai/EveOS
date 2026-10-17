'use strict';

const { randomUUID } = require('node:crypto');

function machineError(code, message) {
  return Object.assign(new Error(message), { code });
}

function cleanName(value, fallback, max = 80) {
  return String(value || fallback)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, max) || fallback;
}

function id(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function samePath(a, b) {
  const normalized = (value) => String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return normalized(a) === normalized(b);
}

function machineState(room) {
  if (!room.machineSpaces || typeof room.machineSpaces !== 'object') {
    room.machineSpaces = { version: 1, spaces: [] };
  }
  room.machineSpaces.spaces = Array.isArray(room.machineSpaces.spaces)
    ? room.machineSpaces.spaces
    : [];
  return room.machineSpaces;
}

function findSpace(room, reference = '') {
  const spaces = machineState(room).spaces.filter((space) => space.archived !== true);
  if (!reference) return spaces.length === 1 ? spaces[0] : null;
  const wanted = String(reference).trim().toLowerCase();
  return spaces.find((space) => space.id === reference)
    || spaces.find((space) => String(space.name || '').trim().toLowerCase() === wanted)
    || null;
}

function publicRequest(request = {}) {
  return {
    requestId: request.requestId,
    actorMemberId: request.actorMemberId || null,
    actorName: request.actorName || 'Agent',
    sourceMessageId: request.sourceMessageId || null,
    terminalId: request.terminalId,
    commandSummary: request.commandSummary || '',
    commandDigest: request.commandDigest || '',
    approvalId: request.approvalId || null,
    grantId: request.grantId || null,
    approvalMode: request.approvalMode || null,
    approvedByMemberId: request.approvedByMemberId || null,
    approvedByName: request.approvedByName || null,
    risk: request.risk || null,
    challenge: request.challenge || '',
    state: request.state || 'approval-required',
    outputId: request.outputId || null,
    preview: request.preview || '',
    bytes: Number.isSafeInteger(request.bytes) ? request.bytes : null,
    exitCode: Number.isInteger(request.exitCode) ? request.exitCode : null,
    reason: request.reason || null,
    createdAt: request.createdAt || null,
    finishedAt: request.finishedAt || null
  };
}

function ownerRequest(request = {}) {
  return { ...publicRequest(request), command: String(request.command || '') };
}

module.exports = {
  machineError,
  cleanName,
  id,
  samePath,
  machineState,
  findSpace,
  publicRequest,
  ownerRequest
};
