'use strict';

const stateApi = require('./server-scheduler-state');
const { TLO_TARGET, TLO_PROVIDER } = require('./tlo-dex-ledger-gate');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

function createTloDexStateAuthority({ stateStore } = {}) {
  if (!stateStore || typeof stateStore.load !== 'function') {
    throw new TypeError('TLO Dex state authority requires the existing server state store.');
  }

  function exactArgs(args = {}) {
    return [args.requestId, args.roomId, args.sourceMessageId]
      .every((value) => typeof value === 'string' && ID.test(value));
  }

  function tloMember(room, memberId) {
    const member = stateApi.memberById(room, memberId);
    return member?.binding?.targetClassId === 'local-origin'
      && member.binding.targetId === TLO_TARGET
      && member.binding.providerId === TLO_PROVIDER;
  }

  function finalReceipt(room, args) {
    return (room?.finalReceipts || []).find((entry) =>
      entry?.requestId === args.requestId
      && entry?.sourceMessageId === args.sourceMessageId
      && typeof entry?.messageId === 'string' && ID.test(entry.messageId)) || null;
  }

  function activeSource(room, args) {
    const journal = room?.recovery;
    return journal?.requestId === args.requestId
      && journal?.sourceMessageId === args.sourceMessageId
      && journal?.targetClassId === 'local-origin'
      && journal?.providerId === TLO_PROVIDER
      && tloMember(room, journal.memberId)
      && !!stateApi.messageById(room, args.sourceMessageId);
  }

  function validateDexSource(args) {
    if (!exactArgs(args)) return false;
    const snapshot = stateStore.load();
    const room = stateApi.roomById(snapshot, args.roomId);
    if (!room) return false;
    return activeSource(room, args) || !!finalReceipt(room, args);
  }

  function verifyDexFinalReceipt(args) {
    if (!exactArgs(args)) return null;
    const snapshot = stateStore.load();
    const room = stateApi.roomById(snapshot, args.roomId);
    const receipt = finalReceipt(room, args);
    if (!receipt) return null;
    const indexed = stateApi.findFinalReceipt(snapshot, args.requestId);
    if (!indexed || indexed.roomId !== args.roomId
        || indexed.sourceMessageId !== args.sourceMessageId
        || indexed.messageId !== receipt.messageId) return null;
    return {
      confirmed: true,
      requestId: args.requestId,
      roomId: args.roomId,
      sourceMessageId: args.sourceMessageId,
      finalRequestId: args.requestId,
      responseMessageId: receipt.messageId
    };
  }

  return Object.freeze({ validateDexSource, verifyDexFinalReceipt });
}

module.exports = { createTloDexStateAuthority };
