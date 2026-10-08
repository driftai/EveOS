(() => {
  'use strict';

  const legacy = document.getElementById('machineSpaceRequests');
  const roomList = document.getElementById('dexRoomList');
  const spaceSelect = document.getElementById('machineSpaceSelect');
  const dexPanel = document.getElementById('dexModePanel');
  if (!legacy || !roomList || !spaceSelect || !dexPanel) return;

  const panel = document.createElement('section');
  panel.className = 'machine-request-view-panel';
  panel.innerHTML = `
    <div class="machine-request-view-head">
      <div>
        <strong>Machine requests</strong>
        <div class="machine-meta" data-request-view-status>Connecting unified terminal · filesystem · supervised history…</div>
      </div>
      <button class="secondary" type="button" data-request-view-refresh>Refresh</button>
    </div>
    <div class="machine-request-view-filters">
      <label>Kind<select data-request-view-kind>
        <option value="">All</option><option value="terminal">Terminal</option>
        <option value="filesystem">Filesystem</option><option value="supervised">Supervised</option>
      </select></label>
      <label>State<select data-request-view-state>
        <option value="">All</option><option value="approval-required">Approval required</option>
        <option value="queued">Queued</option><option value="running">Running</option>
        <option value="deferred">Deferred</option><option value="completed">Completed</option>
        <option value="failed">Failed</option><option value="denied">Denied</option>
        <option value="cancelled">Cancelled</option><option value="outcome-unknown">Outcome unknown</option>
      </select></label>
      <label>Actor<input type="search" data-request-view-actor placeholder="Eve / Vera / member id"></label>
      <label>Search<input type="search" data-request-view-query placeholder="request, grant, digest, output…"></label>
      <label class="machine-request-view-live"><input type="checkbox" data-request-view-live> Live only</label>
      <button class="secondary" type="button" data-request-view-reset>Reset</button>
    </div>
    <div class="machine-request-list" data-request-view-list></div>
    <button class="secondary machine-request-view-more" type="button" data-request-view-more hidden>Load more</button>`;
  legacy.insertAdjacentElement('beforebegin', panel);

  const status = panel.querySelector('[data-request-view-status]');
  const list = panel.querySelector('[data-request-view-list]');
  const kind = panel.querySelector('[data-request-view-kind]');
  const stateFilter = panel.querySelector('[data-request-view-state]');
  const actor = panel.querySelector('[data-request-view-actor]');
  const query = panel.querySelector('[data-request-view-query]');
  const liveOnly = panel.querySelector('[data-request-view-live]');
  const refreshButton = panel.querySelector('[data-request-view-refresh]');
  const resetButton = panel.querySelector('[data-request-view-reset]');
  const moreButton = panel.querySelector('[data-request-view-more]');

  let socket = null;
  let phase = 'connecting';
  let available = false;
  let items = [];
  let nextCursor = null;
  let activeRequestId = '';
  let appendRequest = false;
  let reconnectTimer = null;
  let refreshTimer = null;
  let watchedContext = '';
  const outputs = new Map();

  const roomId = () => roomList.querySelector('.dex-room-item.active')?.dataset.roomId || '';
  const spaceId = () => String(spaceSelect.value || '');
  const contextKey = () => `${roomId()}|${spaceId()}`;
  const editable = () => dexPanel.dataset.humanInput === 'enabled';
  const id = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const send = (payload) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };
  const short = (value, length = 24) => {
    const text = String(value || '');
    return text.length > length ? `${text.slice(0, length)}…` : text;
  };
  function button(label, action, options = {}) {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.className = `secondary${options.danger ? ' danger' : ''}`;
    node.disabled = phase !== 'connected' || (options.owner === true && !editable());
    node.addEventListener('click', action); return node;
  }
  function useUnified(value) {
    legacy.hidden = value === true;
    panel.hidden = false;
  }
  function filters() {
    return {
      kind: kind.value || undefined,
      state: stateFilter.value || undefined,
      actor: actor.value.trim() || undefined,
      query: query.value.trim() || undefined,
      liveOnly: liveOnly.checked
    };
  }
  function requestView({ append = false } = {}) {
    const room = roomId(), space = spaceId();
    if (!room || !space || phase !== 'connected') {
      items = []; nextCursor = null; render(); return false;
    }
    const requestId = id('machine-request-view');
    activeRequestId = requestId; appendRequest = append;
    status.textContent = append ? 'Loading more requests…' : 'Loading unified request history…';
    refreshButton.disabled = true; moreButton.disabled = true;
    return send({
      type: 'machine_request_view', requestId, roomId: room, spaceId: space,
      ...filters(), limit: 24, cursor: append ? nextCursor : null
    });
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => requestView(), 80);
  }
  function watchRoom() {
    const key = contextKey();
    if (key !== watchedContext) {
      watchedContext = key;
      available = false; items = []; nextCursor = null; activeRequestId = '';
      useUnified(false);
      const room = roomId();
      if (room && phase === 'connected') send({ type: 'machine_room_snapshot', roomId: room });
    }
    scheduleRefresh();
  }
  async function approval(item, decision) {
    const raw = item.raw || {};
    if (!raw.approvalId) return;
    const dialog = globalThis.BrowserAiBridgeMachineDialog;
    if (decision === 'deny') {
      send({ type: 'machine_approve_command', approvalId: raw.approvalId, decision: 'deny' });
      return;
    }
    const title = `${item.provenance?.actorName || 'Agent'} · ${item.provenance?.terminalId || 'terminal'}`;
    const body = `${item.summary || raw.command || ''}\n\nRisk: ${raw.risk || 'recorded'}`;
    const allowed = dialog?.confirm
      ? await dialog.confirm('Allow this exact Machine Spaces command once?', `${title}\n${body}`, { confirmText: 'Allow once', cancelText: 'Cancel' })
      : globalThis.confirm(`Allow once?\n\n${title}\n${body}`);
    if (!allowed) return;
    let challenge = '';
    if (raw.risk === 'high' && raw.challenge) {
      challenge = dialog?.prompt
        ? await dialog.prompt(`High-risk command. Type challenge ${raw.challenge} to allow once.`, '', { body, confirmText: 'Allow once', danger: true })
        : globalThis.prompt(`Type challenge ${raw.challenge}`) || '';
      if (challenge == null || String(challenge).trim() !== String(raw.challenge)) return;
    }
    send({ type: 'machine_approve_command', approvalId: raw.approvalId, decision: 'allow-once', challenge: String(challenge || '').trim() });
  }
  function requestOutput(item, offset = 0) {
    const outputId = item.provenance?.outputId || item.raw?.outputId || item.raw?.result?.outputId;
    if (!outputId) return;
    send({ type: 'machine_output_page', roomId: roomId(), outputId, offset, stream: 'combined' });
  }
  function provenanceText(item) {
    const p = item.provenance || {};
    return [
      p.requestId && `request ${p.requestId}`,
      p.sourceMessageId && `message ${p.sourceMessageId}`,
      (p.actorName || p.actorMemberId) && `actor ${p.actorName || p.actorMemberId}`,
      p.terminalId && `terminal ${p.terminalId}`,
      p.processEpoch && `epoch ${short(p.processEpoch)}`,
      p.grantId && `grant ${p.grantId}`,
      p.capability && `cap ${p.capability}`,
      p.commandDigest && `cmd ${short(p.commandDigest)}`,
      p.operationDigest && `op ${short(p.operationDigest)}`,
      p.outputId && `output ${short(p.outputId)}`
    ].filter(Boolean).join(' · ');
  }
  function renderItem(item) {
    const card = document.createElement('div'); card.className = 'machine-request';
    const head = document.createElement('div'); head.className = 'machine-request-head';
    const title = document.createElement('div'); title.className = 'machine-request-title';
    const kindLabel = document.createElement('div'); kindLabel.className = 'machine-request-view-kind'; kindLabel.textContent = item.kind || 'machine';
    const summary = document.createElement('div'); summary.textContent = item.summary || item.id || 'Machine request';
    title.append(kindLabel, summary);
    const badge = document.createElement('span'); badge.className = `machine-state-${item.state}`; badge.textContent = item.state;
    head.append(title, badge);

    const meta = document.createElement('div'); meta.className = 'machine-meta';
    meta.textContent = [item.resultSummary, item.errorCode, item.createdAt].filter(Boolean).join(' · ');
    const provenance = document.createElement('div'); provenance.className = 'machine-request-view-provenance';
    provenance.textContent = provenanceText(item) || 'No provenance identifiers recorded.';
    const actions = document.createElement('div'); actions.className = 'machine-request-actions';
    if (item.kind === 'terminal' && item.state === 'approval-required' && item.raw?.approvalId) {
      actions.append(
        button('Allow once', () => approval(item, 'allow-once'), { owner: true }),
        button('Deny', () => approval(item, 'deny'), { owner: true, danger: true })
      );
    }
    const outputId = item.provenance?.outputId || item.raw?.outputId || item.raw?.result?.outputId;
    if (outputId) actions.append(button('View output', () => requestOutput(item), { owner: false }));
    card.append(head, meta, provenance, actions);

    const cached = outputId ? outputs.get(outputId) : null;
    if (cached) {
      const output = document.createElement('pre'); output.className = 'machine-output'; output.textContent = cached.text || '(no terminal output)';
      card.append(output);
      if (cached.nextOffset != null) card.append(button(`Load more output (${cached.nextOffset}/${cached.totalChars})`, () => requestOutput(item, cached.nextOffset), { owner: false }));
    } else if (item.raw?.preview) {
      const preview = document.createElement('pre'); preview.className = 'machine-output'; preview.textContent = item.raw.preview; card.append(preview);
    }
    return card;
  }
  function render() {
    list.replaceChildren();
    refreshButton.disabled = phase !== 'connected';
    if (!roomId() || !spaceId()) {
      useUnified(false);
      status.textContent = 'Choose a room and Machine Space to inspect requests.';
      list.innerHTML = '<div class="machine-empty">No Machine Space selected.</div>';
      moreButton.hidden = true; return;
    }
    if (phase !== 'connected') {
      useUnified(false);
      status.textContent = 'Unified request view is reconnecting; legacy request history remains available.';
      moreButton.hidden = true; return;
    }
    if (!available) {
      useUnified(false);
      status.textContent = 'Waiting for the unified request-view service; legacy request history remains available.';
      moreButton.hidden = true; return;
    }
    useUnified(true);
    status.textContent = `${items.length} request${items.length === 1 ? '' : 's'} shown${nextCursor ? ' · more available' : ''}`;
    if (!items.length) list.innerHTML = '<div class="machine-empty">No requests match these filters.</div>';
    else for (const item of items) list.append(renderItem(item));
    moreButton.hidden = !nextCursor; moreButton.disabled = false;
  }
  function handleOutput(payload) {
    const prior = outputs.get(payload.outputId);
    const text = payload.offset > 0 && prior?.nextOffset === payload.offset
      ? `${prior.text || ''}${payload.text || ''}` : (payload.text || '');
    outputs.set(payload.outputId, { ...prior, ...payload, text });
    render();
  }
  function handle(payload) {
    if (payload.type === 'machine_request_view') {
      if (payload.requestId !== activeRequestId || payload.roomId !== roomId() || payload.spaceId !== spaceId()) return;
      available = true;
      items = appendRequest ? [...items, ...(payload.items || [])] : [...(payload.items || [])];
      nextCursor = payload.nextCursor || null;
      appendRequest = false; activeRequestId = '';
      render(); return;
    }
    if (payload.type === 'machine_output_page') { handleOutput(payload); return; }
    if (payload.type === 'machine_room_snapshot' || payload.type === 'machine_supervised_jobs'
        || payload.type === 'machine_supervised_job_changed' || payload.type === 'machine_supervised_job_started'
        || payload.type === 'machine_file_grant_changed' || payload.type === 'machine_command_complete'
        || payload.type === 'machine_command_denied') {
      scheduleRefresh(); return;
    }
    if (payload.type === 'error' && payload.requestId === activeRequestId) {
      available = false; activeRequestId = ''; appendRequest = false;
      status.textContent = `${payload.code || 'MACHINE_REQUEST_VIEW_FAILED'}: ${payload.message || 'Unified request view unavailable.'}`;
      useUnified(false);
      render();
    }
  }
  function connect() {
    clearTimeout(reconnectTimer);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws`);
    socket.addEventListener('open', () => {
      phase = 'connected'; available = false; watchedContext = '';
      send({ type: 'hello', role: 'ui', clientKind: 'machine-request-view' });
      setTimeout(watchRoom, 50); render();
    });
    socket.addEventListener('message', (event) => { try { handle(JSON.parse(event.data)); } catch {} });
    socket.addEventListener('close', () => {
      phase = 'reconnecting'; available = false; socket = null; useUnified(false); render();
      reconnectTimer = setTimeout(connect, 1000);
    });
    socket.addEventListener('error', () => {});
  }

  for (const control of [kind, stateFilter, liveOnly]) control.addEventListener('change', () => requestView());
  for (const control of [actor, query]) {
    control.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); requestView(); } });
    control.addEventListener('change', () => requestView());
  }
  refreshButton.addEventListener('click', () => requestView());
  resetButton.addEventListener('click', () => {
    kind.value = ''; stateFilter.value = ''; actor.value = ''; query.value = ''; liveOnly.checked = false; requestView();
  });
  moreButton.addEventListener('click', () => { if (nextCursor) requestView({ append: true }); });
  spaceSelect.addEventListener('change', watchRoom);
  new MutationObserver(watchRoom).observe(roomList, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  new MutationObserver(render).observe(dexPanel, { attributes: true, attributeFilter: ['data-human-input'] });
  new MutationObserver(scheduleRefresh).observe(legacy, { childList: true, subtree: true });

  connect();
  render();
})();
