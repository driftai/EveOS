(() => {
  'use strict';

  const panel = document.getElementById('dexModePanel');
  if (!panel) return;
  const roomList = document.getElementById('dexRoomList');
  const newTerminal = document.getElementById('machineNewTerminal');
  const newTerminalType = document.getElementById('machineNewTerminalType');
  const newTerminalCwd = document.getElementById('machineNewTerminalCwd');

  let socket = null;
  let reconnectTimer = null;
  let lastSent = null;

  function enabled() { return panel.dataset.humanInput === 'enabled'; }
  function activeRoomId() { return roomList?.querySelector('.dex-room-item.active')?.dataset.roomId || ''; }
  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }
  function sync(force = false) {
    const value = enabled();
    if (!force && value === lastSent) return;
    if (send({ type: 'machine_set_human_input', enabled: value })) lastSent = value;
  }
  function createDexTerminal(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const roomId = activeRoomId();
    if (!enabled() || !roomId) return;
    send({
      type: 'machine_create_target',
      roomId,
      targetType: String(newTerminalType?.value || ''),
      label: '',
      cwd: String(newTerminalCwd?.value || '')
    });
  }
  function connect() {
    clearTimeout(reconnectTimer);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws`);
    socket.addEventListener('open', () => {
      lastSent = null;
      send({ type: 'hello', role: 'ui', clientKind: 'machine-human-gate' });
      setTimeout(() => sync(true), 25);
    });
    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'machine_human_input_state') {
          globalThis.BrowserAiBridgeMachineHumanGate = Object.freeze({ enabled: payload.enabled === true });
          globalThis.dispatchEvent?.(new CustomEvent('machine-human-gate-change', { detail: { enabled: payload.enabled === true } }));
        }
      } catch {}
    });
    socket.addEventListener('close', () => {
      socket = null; lastSent = null;
      globalThis.BrowserAiBridgeMachineHumanGate = Object.freeze({ enabled: false });
      globalThis.dispatchEvent?.(new CustomEvent('machine-human-gate-change', { detail: { enabled: false } }));
      reconnectTimer = setTimeout(connect, 1000);
    });
    socket.addEventListener('error', () => {});
  }

  new MutationObserver(() => sync()).observe(panel, { attributes: true, attributeFilter: ['data-human-input'] });
  newTerminal?.addEventListener('click', createDexTerminal, true);
  addEventListener('pagehide', () => {
    clearTimeout(reconnectTimer);
    try { if (socket?.readyState === WebSocket.OPEN) send({ type: 'machine_set_human_input', enabled: false }); } catch {}
    try { socket?.close(); } catch {}
  }, { once: true });

  globalThis.BrowserAiBridgeMachineHumanGate = Object.freeze({ enabled: false });
  connect();
})();
