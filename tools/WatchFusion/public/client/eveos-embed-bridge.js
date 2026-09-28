(function () {
  'use strict';

  if (window.__watchFusionEveBridgeReady) return;
  window.__watchFusionEveBridgeReady = true;

  const embedded = window.parent && window.parent !== window;
  const detached = !embedded && window.opener && !window.opener.closed;
  const role = embedded ? 'embedded' : detached ? 'detached' : 'standalone';
  const eveHost = embedded ? window.parent : detached ? window.opener : null;
  const stateBridge = window.watchFusionContinuityState;
  const TRANSFER_TIMEOUT_MS = 30000;

  let storageAccess = null;
  let sessionId = '';
  let active = embedded;
  let applying = false;
  let pendingTransfer = null;
  let initialRequestTimer = null;
  let initialRequestId = '';
  let closingAfterTransfer = false;
  let manualReturnStarted = false;
  let requestAttempts = 0;
  let reattachPromise = null;
  let incomingTransferId = '';
  const completedTransferIds = new Set();

  function makeId() {
    try {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    } catch {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function post(type, payload = {}) {
    if (!eveHost || !sessionId) return false;
    try {
      eveHost.postMessage({
        source: 'WatchFusion',
        version: 2,
        type,
        sessionId,
        role,
        ...payload
      }, '*');
      return true;
    } catch {
      return false;
    }
  }

  async function recoverSource(snapshot, message) {
    try {
      await stateBridge?.applySnapshot?.(snapshot, role);
      active = true;
      document.documentElement.classList.remove('watchfusion-continuity-parked');
    } catch {}
    if (message) setStatus?.(message);
  }

  function setReattachBusy(busy) {
    const button = document.getElementById('reattachEveOSBtn');
    if (!button) return;
    button.disabled = !!busy;
    button.textContent = busy ? '↙ Reattaching…' : '↙ Reattach to EveOS';
  }

  function clearPendingTransfer() {
    const transfer = pendingTransfer;
    if (!transfer) return null;
    clearTimeout(transfer.timer);
    clearInterval(transfer.retryTimer);
    pendingTransfer = null;
    return transfer;
  }

  function sendTransfer(transfer) {
    if (!transfer) return;
    if (transfer.closeAfter) post('watchfusion:reattach-request', {
      requestId: transfer.requestId,
      targetRole: transfer.targetRole
    });
    post('watchfusion:continuity-handoff', {
      requestId: transfer.requestId,
      sourceRole: role,
      targetRole: transfer.targetRole,
      snapshot: transfer.snapshot
    });
  }

  async function beginTransfer(targetRole, {
    requestId = makeId(),
    closeAfter = false,
    includeBlob = true
  } = {}) {
    if (!active || applying || pendingTransfer || !sessionId || !stateBridge) {
      console.log('[EMBEDDED LOG] beginTransfer blocked:', { active, applying, pending: Boolean(pendingTransfer), sess: Boolean(sessionId), bridge: Boolean(stateBridge) });
      return false;
    }
    applying = true;
    try {
      const snapshot = await stateBridge.captureSnapshot({ includeBlob });
      stateBridge.parkCurrentOwner();
      const transfer = {
        requestId,
        targetRole,
        snapshot,
        closeAfter,
        retryTimer: 0,
        timer: setTimeout(() => {
          const stalled = pendingTransfer;
          if (!stalled || stalled.requestId !== requestId) return;
          clearPendingTransfer();
          closingAfterTransfer = false;
          setReattachBusy(false);
          post('watchfusion:continuity-failed', {
            requestId,
            sourceRole: role,
            targetRole,
            error: `${role === 'detached' ? 'Reattach' : 'Detach'} handoff timed out`
          });
          recoverSource(stalled.snapshot, `${role === 'detached' ? 'Reattach' : 'Detach'} handoff timed out; playback stayed in this window.`);
        }, TRANSFER_TIMEOUT_MS)
      };
      pendingTransfer = transfer;
      if (closeAfter) {
        closingAfterTransfer = true;
      }
      sendTransfer(transfer);
      transfer.retryTimer = setInterval(() => {
        if (pendingTransfer?.requestId === requestId) sendTransfer(transfer);
      }, 750);
      return true;
    } catch (error) {
      setStatus?.(`Could not transfer WatchFusion state: ${error?.message || error}`);
      return false;
    } finally {
      applying = false;
    }
  }

  function startInitialDetachedRequest() {
    if (role !== 'detached' || active || initialRequestId || !sessionId || closingAfterTransfer || manualReturnStarted) return;
    initialRequestId = makeId();
    requestAttempts = 0;
    const request = () => {
      if (active || !initialRequestId || requestAttempts >= 8 || closingAfterTransfer || manualReturnStarted) {
        if (initialRequestTimer) clearInterval(initialRequestTimer);
        initialRequestTimer = null;
        return;
      }
      requestAttempts += 1;
      post('watchfusion:continuity-request', {
        requestId: initialRequestId,
        sourceRole: 'detached',
        targetRole: 'detached'
      });
    };
    request();
    initialRequestTimer = setInterval(request, 750);
  }

  async function handleHostMessage(event) {
    if (!eveHost || event.source !== eveHost) return;
    const data = event.data;
    if (!data || data.source !== 'EveOS' || data.version !== 1) return;

    if (data.type === 'watchfusion:continuity-config') {
      if (data.role !== role || !data.sessionId) return;
      sessionId = String(data.sessionId);
      startInitialDetachedRequest();
      return;
    }

    if (!sessionId || data.sessionId !== sessionId) return;

    if (data.type === 'watchfusion:continuity-request') {
      if (role !== 'embedded' || data.targetRole === role) return;
      if (pendingTransfer && pendingTransfer.requestId !== data.requestId) {
        clearPendingTransfer();
      }
      await beginTransfer(data.targetRole, { requestId: data.requestId });
      return;
    }

    if (data.type === 'watchfusion:continuity-handoff') {
      if (data.targetRole !== role || !data.snapshot) return;
      if (completedTransferIds.has(data.requestId)) {
        post('watchfusion:continuity-applied', {
          requestId: data.requestId,
          sourceRole: data.sourceRole,
          targetRole: role
        });
        return;
      }
      if (incomingTransferId === data.requestId) return;
      if (initialRequestTimer) clearInterval(initialRequestTimer);
      initialRequestTimer = null;
      initialRequestId = '';
      if (pendingTransfer) {
        clearPendingTransfer();
      }
      incomingTransferId = data.requestId;
      applying = true;
      try {
        await stateBridge?.applySnapshot?.(data.snapshot, role);
        active = true;
        completedTransferIds.add(data.requestId);
        if (completedTransferIds.size > 8) completedTransferIds.delete(completedTransferIds.values().next().value);
        post('watchfusion:continuity-applied', {
          requestId: data.requestId,
          sourceRole: data.sourceRole,
          targetRole: role
        });
      } catch (error) {
        post('watchfusion:continuity-failed', {
          requestId: data.requestId,
          sourceRole: data.sourceRole,
          targetRole: role,
          error: String(error?.message || error || 'state restore failed')
        });
      } finally {
        incomingTransferId = '';
        applying = false;
      }
      return;
    }

    if (data.type === 'watchfusion:continuity-applied') {
      if (!pendingTransfer || data.requestId !== pendingTransfer.requestId) return;
      const closeAfter = clearPendingTransfer()?.closeAfter;
      active = false;
      window.__watchFusionContinuityApplying = true;
      if (closeAfter && role === 'detached') {
        closingAfterTransfer = true;
        if (initialRequestTimer) clearInterval(initialRequestTimer);
        initialRequestTimer = null;
        initialRequestId = '';
        setTimeout(() => window.close(), 50);
      }
      return;
    }

    if (data.type === 'watchfusion:continuity-failed') {
      if (!pendingTransfer || data.requestId !== pendingTransfer.requestId) return;
      const snapshot = clearPendingTransfer()?.snapshot;
      closingAfterTransfer = false;
      setReattachBusy(false);
      await recoverSource(
        snapshot,
        `State transfer failed; playback stayed here. ${data.error || ''}`.trim()
      );
    }
  }

  function waitForTransferReady(timeoutMs = 12000) {
    const ready = () => active && !applying && !pendingTransfer && !!sessionId && !!stateBridge;
    if (ready()) return Promise.resolve(true);
    return new Promise(resolve => {
      const started = performance.now();
      const timer = setInterval(() => {
        if (ready() || performance.now() - started >= timeoutMs) {
          clearInterval(timer);
          resolve(ready());
        }
      }, 100);
    });
  }

  function reattachToEveOS() {
    if (reattachPromise) return reattachPromise;
    if (!window.opener || window.opener.closed) {
      setStatus?.('EveOS is no longer open. Keep this WatchFusion window open or reopen EveOS first.');
      return Promise.resolve(false);
    }
    setReattachBusy(true);
    setStatus?.('Preparing WatchFusion to reattach…');
    reattachPromise = (async () => {
      if (!(await waitForTransferReady())) {
        setStatus?.('WatchFusion is still loading. Reattach was not started; playback remains here.');
        return false;
      }
      return beginTransfer('embedded', { closeAfter: true });
    })().finally(() => {
      reattachPromise = null;
      if (!pendingTransfer && !closingAfterTransfer) setReattachBusy(false);
    });
    return reattachPromise;
  }

  function ensureReattachButton() {
    if (!detached || document.getElementById('reattachEveOSBtn')) return;
    const header = document.getElementById('watchfusionHeader');
    const toggle = document.getElementById('headerToggleBtn');
    if (!header) return;
    const button = document.createElement('button');
    button.id = 'reattachEveOSBtn';
    button.className = 'secondary';
    button.type = 'button';
    button.textContent = '↙ Reattach to EveOS';
    button.title = 'Move the current WatchFusion state back into EveOS';
    button.addEventListener('click', reattachToEveOS);
    header.insertBefore(button, toggle || null);
  }

  async function sampleStorageAccess() {
    if (typeof document.hasStorageAccess !== 'function') return;
    try { storageAccess = await document.hasStorageAccess(); }
    catch { storageAccess = null; }
    document.documentElement.classList.toggle('watchfusion-storage-partitioned', storageAccess === false);
  }

  function presenceMessage(type) {
    return {
      source: 'WatchFusion',
      version: 1,
      type,
      url: location.href,
      embedded,
      detached,
      windowName: window.name || '',
      storageAccess,
      time: Date.now()
    };
  }

  function heartbeat() {
    if (closingAfterTransfer || manualReturnStarted) return;
    try {
      if (embedded) window.parent.postMessage(presenceMessage('watchfusion:embedded-presence'), '*');
      if (detached) window.opener.postMessage(presenceMessage('watchfusion:detached-presence'), '*');
    } catch {}
  }

  function emergencyReturn() {
    if (!detached || closingAfterTransfer || manualReturnStarted || !active || !sessionId) return;
    if (!window.opener || window.opener.closed || !stateBridge) return;
    manualReturnStarted = true;
    window.__watchFusionContinuityApplying = true;
    try {
      const requestId = makeId();
      const snapshot = stateBridge.captureEmergencySnapshot();
      post('watchfusion:reattach-request', {
        requestId,
        targetRole: 'embedded',
        emergency: true
      });
      post('watchfusion:continuity-handoff', {
        requestId,
        sourceRole: 'detached',
        targetRole: 'embedded',
        snapshot,
        emergency: true
      });
      active = false;
    } catch {}
  }

  function handleBeforeUnload() {
    emergencyReturn();
    const transferred = sessionId && (!active || pendingTransfer || closingAfterTransfer || manualReturnStarted);
    if (!transferred) return;
    // The peer now owns this logical WatchFusion session. Prevent the normal
    // beforeunload room-leave beacon from ejecting that same transferred member.
    try { roomId = null; } catch {}
    try { session = null; } catch {}
  }

  window.addEventListener('message', handleHostMessage);
  window.addEventListener('beforeunload', handleBeforeUnload, true);

  window.watchFusionEveContinuity = Object.freeze({
    role,
    isActive: () => active,
    isApplying: () => applying,
    shouldSuppressLeave: () => Boolean(
      sessionId && (!active || applying || pendingTransfer || closingAfterTransfer || manualReturnStarted)
    ),
    capture: () => stateBridge?.captureSnapshot?.(),
    reattach: reattachToEveOS
  });
  window.watchFusionEveBridge = Object.freeze({ heartbeat });

  ensureReattachButton();
  sampleStorageAccess().finally(heartbeat);
  window.setInterval(() => {
    ensureReattachButton();
    heartbeat();
  }, 1500);
  window.addEventListener('pageshow', () => { sampleStorageAccess(); heartbeat(); });
  document.addEventListener('visibilitychange', heartbeat);
})();
