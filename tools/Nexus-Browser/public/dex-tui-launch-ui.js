(() => {
  // UI-only convenience; actual execution stays in a fixed-command localhost route.
  // The button acts on the selected room, not on a room name typed by the user.
  const head = document.querySelector('.dex-sidebar-head');
  if (!head || document.getElementById('dexOpenTui')) return;
  const button = document.createElement('button');
  button.id = 'dexOpenTui'; button.type = 'button'; button.className = 'secondary';
  button.textContent = 'Open TUI'; button.title = 'Open the selected Dex room in a new PowerShell window';
  const status = document.createElement('p');
  status.id = 'dexOpenTuiStatus'; status.setAttribute('role', 'status');
  status.style.fontSize = '0.75rem';
  head.append(button);
  head.insertAdjacentElement('afterend', status);
  button.addEventListener('click', () => {
    const selected = document.querySelector('#dexRoomList .dex-room-item.active');
    const roomId = selected?.dataset?.roomId || '';
    if (!/^room-[A-Za-z0-9_-]{6,125}$/.test(roomId)) { status.textContent = 'Select a Dex room first.'; return; }
    if (!['http:', 'https:'].includes(location.protocol)) {
      status.textContent = 'Open Nexus at its localhost URL to launch PowerShell.'; return;
    }
    const requestId = `dex-tui-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    let completed = false;
    const timeout = setTimeout(() => { if (!completed) { status.textContent = 'Launch outcome unknown. Inspect the terminal before trying again.'; socket.close(); } }, 12000);
    button.disabled = true; status.textContent = 'Opening selected room…';
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'tui-launch' }));
      socket.send(JSON.stringify({ type: 'dex_launch_room_tui', requestId, roomId }));
    });
    socket.addEventListener('message', event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.type !== 'dex_tui_launch_result' || data.requestId !== requestId) return;
      completed = true; clearTimeout(timeout); button.disabled = false; socket.close();
      status.textContent = data.ok ? 'Terminal opened for the selected room.'
        : `${data.code || 'Launch rejected'}: ${data.message || 'No action taken.'}`;
    });
    socket.addEventListener('close', () => {
      clearTimeout(timeout); button.disabled = false;
      if (!completed) status.textContent = 'Connection lost; check whether a terminal opened before retrying.';
    });
    socket.addEventListener('error', () => { if (!completed) status.textContent = 'Nexus connection failed.'; });
  });
})();
