'use strict';

function createSafeSend({ openState = 1, onError = () => {} } = {}) {
  return function safeSend(ws, payload) {
    if (!ws || ws.readyState !== openState) return false;
    let body;
    try { body = JSON.stringify(payload); }
    catch (error) { try { onError(error, { phase: 'serialize', payload }); } catch {} return false; }
    try {
      ws.send(body, (error) => {
        if (!error) return;
        try { onError(error, { phase: 'callback', payload }); } catch {}
      });
      return true;
    } catch (error) {
      try { onError(error, { phase: 'send', payload }); } catch {}
      return false;
    }
  };
}

function guardAsyncHandler(handler, { onError = () => {} } = {}) {
  return function guardedAsyncHandler(...args) {
    Promise.resolve()
      .then(() => handler(...args))
      .catch((error) => {
        try { onError(error, ...args); } catch {}
      });
  };
}

function requestIdFromRaw(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed?.requestId ? String(parsed.requestId) : null;
  } catch {
    return null;
  }
}

module.exports = { createSafeSend, guardAsyncHandler, requestIdFromRaw };
