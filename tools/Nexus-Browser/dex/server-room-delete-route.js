'use strict';

const lifecycle = require('./server-room-lifecycle');

function createRoomDeleteRoute({
  dexRouting, machineSpaces, providerControlRouting, maintenanceBusy = () => false,
  stateStore, broadcastState = () => {}, safeSend = () => false
} = {}) {
  function providerControlActive(room) {
    return [...(providerControlRouting?.pending?.values?.() || [])]
      .some((entry) => entry?.origin?.roomId === room.id);
  }

  function handle(ws, msg = {}) {
    if (msg.type === 'dex_request_primary') {
      const claimed = dexRouting?.claimPrimaryDex?.(ws) === true;
      safeSend(ws, claimed
        ? { type: 'dex_state_snapshot', snapshot: stateStore?.load?.() }
        : { type: 'error', requestId: msg.requestId || null, code: 'DEX_PRIMARY_CLAIM_DENIED', message: 'Only a connected Dex viewer may claim the editing role.' });
      return true;
    }
    if (msg.type !== 'dex_room_delete' || ws?.clientKind !== 'dex') return false;
    let result;
    if (!dexRouting?.isPrimaryDex?.(ws)) {
      result = { ok: false, code: 'DEX_RUNTIME_STANDBY', message: 'Only the primary Dex controller may delete rooms.' };
    } else if (maintenanceBusy()) {
      result = { ok: false, code: 'POST_IDLE_LEASE_BUSY', message: 'Post-idle maintenance blocks room deletion.' };
    } else {
      result = lifecycle.deleteRoom(stateStore?.load?.(), msg, {
        humanInputEnabled: machineSpaces?.humanInputGate?.enabled?.() === true,
        providerControlActive
      });
    }
    if (result.ok) {
      const saved = stateStore.save(result.snapshot);
      broadcastState(saved);
    }
    safeSend(ws, result.ok
      ? { type: 'dex_room_delete_result', requestId: msg.requestId || null, ...result, snapshot: undefined }
      : { type: 'error', requestId: msg.requestId || null, code: result.code, message: result.message });
    return true;
  }

  return { handle, providerControlActive };
}

module.exports = { createRoomDeleteRoute };
