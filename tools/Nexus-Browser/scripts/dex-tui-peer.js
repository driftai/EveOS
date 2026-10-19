'use strict';
// One local UI socket per Base/Spaces view. No auto-reconnect or resend after
// ambiguous delivery. A reconnect requires an explicit fresh user action.
const { endpoint } = require('./dex-room-terminal');
function createPeer({ WebSocketImpl = null, url = endpoint(), onEvent = () => {}, timeoutMs = 12000 } = {}) {
  WebSocketImpl ||= require('ws').WebSocket;
  const socket = new WebSocketImpl(url);
  const waiters = new Set();
  let ready = false, closed = false;
  const fail = (error) => {
    for (const entry of [...waiters]) entry.finish(error);
  };
  function waitFor(match, timeout = timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { match, finish(error, result) {
        if (!waiters.delete(entry)) return;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      } };
      const timer = setTimeout(() => entry.finish(new Error('Nexus response timed out. No automatic retry.')), timeout);
      waiters.add(entry);
    });
  }
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    for (const entry of [...waiters]) {
      if (entry.match(message)) { entry.finish(null, message); break; }
    }
    onEvent(message);
  });
  socket.on('close', () => {
    ready = false;
    fail(new Error('Nexus socket closed. Any in-flight prompt has an unknown outcome; do not resend.'));
    if (!closed) onEvent({ type: 'transport_closed' });
  });
  socket.on('error', error => {
    fail(error);
    if (!closed) onEvent({ type: 'transport_closed' });
  });
  const start = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Nexus connection timed out.')), timeoutMs);
    socket.once('open', () => {
      if (closed) return;
      socket.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'browser' }));
      ready = true;
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', error => { clearTimeout(timeout); reject(error); });
    socket.once('close', () => { clearTimeout(timeout); reject(new Error('Nexus closed before connection.')); });
  });
  function send(message) {
    if (!ready || closed || socket.readyState !== WebSocketImpl.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  async function request(message, match, timeout) {
    if (!ready) throw new Error('Nexus is not connected.');
    const pending = waitFor(response => response.type === 'error' || match(response), timeout);
    if (!send(message)) { // Never retry a request after a possibly open socket.
      close();
      await pending.catch(() => {});
      throw new Error('Nexus connection lost before request.');
    }
    const response = await pending;
    if (response.type === 'error') throw Object.assign(new Error(response.message || 'Nexus rejected request.'), { code: response.code });
    return response;
  }
  function close() { closed = true; ready = false; fail(new Error('TUI view closed.')); try { socket.close(); } catch {} }
  return { start, send, request, close, isOpen: () => ready && !closed };
}
module.exports = { createPeer };
