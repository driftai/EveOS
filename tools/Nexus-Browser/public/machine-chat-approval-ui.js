(() => {
  'use strict';

  const APPROVAL = /^\/approve-playwright\s+(machine-job-[A-Za-z0-9-]{1,180})\s+([a-f0-9]{12})\s+([a-f0-9]{12})$/i;
  const WORKFLOW_APPROVAL = /^\/approve-workflow\s+(machine-job-[A-Za-z0-9-]{1,180})\s+([a-f0-9]{12})\s+([a-f0-9]{12})$/i;
  const SHORTHAND = /^(?:\/approve|yes[,.]?\s+go\s+ahead)[.!]?$/i;
  function parse(value) {
    const approvalText = String(value || '').trim();
    const match = APPROVAL.exec(approvalText) || WORKFLOW_APPROVAL.exec(approvalText);
    if (match) return { approvalText, jobId: match[1], commandDigestPrefix: match[2].toLowerCase(),
      challenge: match[3].toUpperCase() };
    return SHORTHAND.test(approvalText)
      ? { approvalText, approvalIntent: 'single-pending-supervised' } : null;
  }
  const api = { parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || typeof WebSocket === 'undefined') return;

  const panel = document.getElementById('dexModePanel');
  const prompt = document.getElementById('dexPrompt');
  const sendButton = document.getElementById('dexSend');
  const roomList = document.getElementById('dexRoomList');
  const diagnostics = document.getElementById('dexDiagnostics');
  if (!panel || !prompt || !sendButton || !roomList) return;
  let socket = null, reconnectTimer = null, pending = null, jobs = [];
  const activeRoomId = () => roomList.querySelector('.dex-room-item.active')?.dataset.roomId || '';
  const pendingInRoom = (roomId) => jobs.filter((job) => job?.roomId === roomId
    && job.state === 'queued' && job.chatApproval);
  function note(value) {
    if (!diagnostics) return;
    diagnostics.textContent = `[${new Date().toLocaleTimeString()}] ${value}\n${diagnostics.textContent || ''}`.slice(0, 12000);
  }
  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const authorized = globalThis.BrowserAiBridgeMachineHumanGate?.authorize?.(payload) || payload;
    socket.send(JSON.stringify(authorized)); return true;
  }
  function submit(event) {
    const parsed = parse(prompt.value);
    if (!parsed) return false;
    const roomId = activeRoomId();
    if (parsed.approvalIntent) {
      const candidates = pendingInRoom(roomId);
      if (!candidates.length) return false;
      if (candidates.length !== 1) {
        event?.preventDefault?.(); event?.stopImmediatePropagation?.();
        return note('Multiple supervised jobs await approval; use the exact job-specific phrase.'), true;
      }
    }
    event?.preventDefault?.(); event?.stopImmediatePropagation?.();
    if (pending) return note('A supervised chat approval is already being submitted.'), true;
    if (!roomId) return note('Select the exact Dex room before approving its supervised job.'), true;
    if (panel.dataset.humanInput !== 'enabled') return note('Enable Human Input before approving a supervised job from chat.'), true;
    const requestId = `machine-chat-approval-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    pending = { requestId, original: prompt.value };
    if (!send({ type: 'machine_chat_approve_supervised_job', requestId, roomId, ...parsed })) {
      pending = null; note('Nexus is disconnected; the supervised job was not approved.'); return true;
    }
    prompt.value = '';
    return true;
  }
  function connect() {
    clearTimeout(reconnectTimer);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws`);
    socket.addEventListener('open', () => {
      send({ type: 'hello', role: 'ui', clientKind: 'machine-chat-approval',
        uiHolderId: globalThis.BrowserAiBridgeUiSocket?.uiHolderId });
      send({ type: 'machine_supervised_jobs' });
    });
    socket.addEventListener('message', (event) => {
      let payload; try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === 'machine_supervised_jobs') jobs = Array.isArray(payload.jobs) ? payload.jobs : jobs;
      if (!pending || payload.requestId !== pending.requestId) return;
      if (payload.type === 'machine_supervised_job_changed' && payload.action === 'started') {
        note(`Approved and started ${payload.job?.jobId || 'the Playwright job'} from exact local chat consent.`); pending = null;
      } else if (payload.type === 'error') {
        if (!prompt.value) prompt.value = pending.original;
        note(`${payload.code || 'APPROVAL_FAILED'}: ${payload.message || 'Playwright approval failed.'}`); pending = null;
      }
    });
    socket.addEventListener('close', () => {
      if (pending && !prompt.value) prompt.value = pending.original;
      pending = null; socket = null; reconnectTimer = setTimeout(connect, 1000);
    });
    socket.addEventListener('error', () => {});
  }
  sendButton.addEventListener('click', submit, true);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && parse(prompt.value)) submit(event);
  }, true);
  addEventListener('pagehide', () => { clearTimeout(reconnectTimer); try { socket?.close(); } catch {} }, { once: true });
  connect();
  globalThis.BrowserAiBridgeMachineChatApproval = api;
})();
