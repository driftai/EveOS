'use strict';

const entryCheck = require('./provider-control-entry-check');
const controlReceipt = require('./provider-control-receipt');

const fail = (code, message, origin = null) => ({ ok: false, code, message, origin });

function authorize({ snapshot, source = {}, command = {}, requestId = '', trusted = null } = {}) {
  const entry = entryCheck.authorize(snapshot, source, command);
  if (!trusted) {
    if (!entry.ok) return entry;
    const roomId = entry.roomId || null;
    return { ok: true, entry, roomId, origin: null,
      routedCommand: roomId && !String(command.room || '').trim() ? { ...command, room: roomId } : command };
  }
  if (String(source.targetClassId || '').trim().toLowerCase() !== 'local-origin')
    return fail('DEX_CONTROL_PROVENANCE_INVALID', 'Only a captured Local-Origin command may use durable local room provenance.');
  const roomId = String(trusted.roomId || '');
  const origin = roomId ? controlReceipt.findIntentInRoom(snapshot, roomId, source, command) : null;
  if (!origin) return fail('DEX_CONTROL_ORIGIN_UNCORRELATED',
    'The captured local command no longer matches its exact durable room intent. No command executed.');
  if (String(origin.controlRequestId || '') !== String(requestId)
    || String(trusted.controlRequestId || '') !== String(requestId)
    || String(origin.agentMessageId || '') !== String(trusted.agentMessageId || '')
    || String(origin.executorMemberId || '') !== String(trusted.executorMemberId || '')) {
    return fail('DEX_CONTROL_ORIGIN_UNCORRELATED',
      'The captured local command identity changed before routing. No command executed.', origin);
  }
  if (!entry.ok) return { ...entry, origin };
  if (entry.roomId && entry.roomId !== roomId) return fail('DEX_CONTROL_ORIGIN_UNCORRELATED',
    'The command names a different room than its authenticated durable origin. No command executed.', origin);
  return { ok: true, entry, roomId, origin,
    routedCommand: String(command.room || '').trim() ? command : { ...command, room: roomId } };
}

module.exports = { authorize };
