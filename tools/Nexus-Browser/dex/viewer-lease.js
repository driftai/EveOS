'use strict';

const { randomUUID } = require('node:crypto');

const MIN_DURATION_SECONDS = 15;
const MAX_DURATION_SECONDS = 600;
const DEFAULT_DURATION_SECONDS = 300;

function failure(code, message) {
  return { ok: false, code, message };
}

function createDexViewerLease({
  uiSockets,
  safeSend,
  isIdle = () => ({ ok: true }),
  now = () => Date.now(),
  uid = randomUUID,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (!uiSockets || typeof safeSend !== 'function') {
    throw new TypeError('Dex viewer lease requires the live UI socket set and safe sender.');
  }
  let active = null;
  let expiryTimer = null;

  function clearExpired() {
    if (active && Number(active.expiresAt || 0) <= now()) active = null;
    if (!active && expiryTimer != null) {
      clearTimer(expiryTimer);
      expiryTimer = null;
    }
  }

  function diagnostics() {
    clearExpired();
    return active ? { ...active } : { active: false };
  }

  function begin({ requestId, durationSeconds = DEFAULT_DURATION_SECONDS } = {}) {
    clearExpired();
    if (active) return failure('DEX_VIEWER_LEASE_BUSY', 'A bounded Dex viewer standby lease is already active.');
    const idle = isIdle() || { ok: false };
    if (idle.ok !== true) {
      return failure(idle.code || 'DEX_VIEWER_LEASE_NOT_IDLE', idle.message || 'Dex has active or unresolved work.');
    }
    const seconds = Number(durationSeconds);
    if (!Number.isInteger(seconds) || seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
      return failure('DEX_VIEWER_LEASE_BAD_DURATION', `Use a ${MIN_DURATION_SECONDS}..${MAX_DURATION_SECONDS} second viewer lease.`);
    }
    const leaseId = `dex-viewer-lease-${uid()}`;
    const expiresAt = now() + seconds * 1000;
    const viewers = [...uiSockets].filter((peer) => peer?.clientKind === 'dex');
    let notified = 0;
    for (const peer of viewers) {
      if (safeSend(peer, {
        type: 'dex_viewer_lease', action: 'standby', requestId: String(requestId || ''), leaseId, expiresAt
      })) notified += 1;
    }
    if (notified !== viewers.length) {
      return failure('DEX_VIEWER_LEASE_DELIVERY_FAILED', 'Not every connected Dex viewer accepted the standby lease; no headless claim was made.');
    }
    active = {
      active: true, leaseId, requestId: String(requestId || ''),
      startedAt: now(), expiresAt, viewersNotified: notified
    };
    expiryTimer = setTimer(() => { active = null; expiryTimer = null; }, seconds * 1000);
    return {
      ok: true, action: 'viewer-standby', leaseId, expiresAt, viewersNotified: notified,
      alreadyHeadless: viewers.length === 0,
      message: viewers.length
        ? `Requested bounded standby from ${viewers.length} Dex viewer(s); verify dexUiConnected=false before dispatch.`
        : 'Dex is already headless; the Search Monitor service workspace was not changed.'
    };
  }

  return { begin, diagnostics };
}

function createServerDexViewerLease({
  uiSockets, safeSend, loadRooms = () => [], scheduler = null,
  maintenanceBusy = () => false, providerControlPending = () => false
} = {}) {
  return createDexViewerLease({
    uiSockets,
    safeSend,
    isIdle() {
      const rooms = loadRooms() || [];
      if (scheduler?.diagnostics?.()?.current || rooms.some((room) => room.relay?.active || room.recovery)) {
        return { ok: false, code: 'DEX_VIEWER_LEASE_WORK_ACTIVE', message: 'Dex relay or recovery work is active.' };
      }
      if (maintenanceBusy() || providerControlPending() || rooms.some((room) => !!room.pendingProviderControlReceipt)) {
        return { ok: false, code: 'DEX_VIEWER_LEASE_CONTROL_PENDING', message: 'Maintenance or provider-control work is pending.' };
      }
      return { ok: true };
    }
  });
}

module.exports = { MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, DEFAULT_DURATION_SECONDS, createDexViewerLease, createServerDexViewerLease };
