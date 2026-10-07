(() => {
  'use strict';
  const socketApi = globalThis.BrowserAiBridgeUiSocket;
  const handoff = globalThis.BrowserAiBridgeWorkspaceHandoff;
  if (!socketApi) throw new Error('Machine Spaces requires the shared UI socket helper.');

  const byId = (id) => document.getElementById(id);
  const el = Object.fromEntries([
    'targetClassSelect','onlineTargetControls','localTargetControls','appTargetControls','terminalTargetControls',
    'terminalTypeSelect','terminalLabel','terminalCwd','terminalTargetSelect','refreshTerminalTargets',
    'createTerminalTarget','connectTerminalTarget','interruptTerminal','stopTerminalTarget','terminalTargetStatus',
    'terminalRelayPanel','bridgeBadge','targetStatus','prompt','captureLatest','sendPrompt','transcript',
    'dexModePanel','dexRoomList','machineCreateSpace','machineArchiveSpace','machineSpaceSelect',
    'machineAttachTarget','machineAttach','machineSpaceStatus','machineSpaceResources','machineSpaceRequests'
  ].map((id) => [id, byId(id)]));
  const state = { phase: 'connecting', targets: [], types: [], selectedId: '', roomId: '', room: null };
  const outputs = new Map(), commandText = new Map();
  const OWNER_KEY = 'browser-ai-bridge.machine-owner.v1';
  let socket = null;

  function stableOwner() {
    let value = '';
    try { value = localStorage.getItem(OWNER_KEY) || ''; } catch {}
    if (!/^machine-owner-[A-Za-z0-9-]{8,96}$/.test(value)) {
      value = `machine-owner-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      try { localStorage.setItem(OWNER_KEY, value); } catch {}
    }
    return value;
  }
  const ownerId = stableOwner();
  const requestId = () => `machine-request-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const connected = () => state.phase === 'connected';
  const isMachine = () => el.targetClassSelect?.value === 'terminal-origin';
  const activeTarget = () => state.targets.find((target) => target.id === state.selectedId) || null;
  function send(payload) { return socket?.send(payload) || false; }

  function message(role, text, id = '') {
    let node = id ? el.transcript?.querySelector(`[data-machine-message-id="${CSS.escape(id)}"]`) : null;
    if (!node) {
      node = document.createElement('article');
      node.className = `message ${role}`;
      if (id) node.dataset.machineMessageId = id;
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Managed terminal' : 'System';
      const body = document.createElement('div');
      body.className = 'message-body';
      node.append(label, body);
      el.transcript?.append(node);
    }
    node.querySelector('.message-body').textContent = text;
    if (el.transcript) el.transcript.scrollTop = el.transcript.scrollHeight;
    return node;
  }
  function setOptions(select, items, value, emptyText, label) {
    select.replaceChildren();
    if (!items.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = emptyText;
      select.append(option); return '';
    }
    for (const item of items) {
      const option = document.createElement('option'); option.value = item.id; option.textContent = label(item);
      select.append(option);
    }
    const next = items.some((item) => item.id === value) ? value : items[0].id;
    select.value = next; return next;
  }
  function renderTargets() {
    const oldType = el.terminalTypeSelect.value;
    setOptions(el.terminalTypeSelect, state.types, oldType, 'No terminal types', (item) => item.name);
    state.selectedId = setOptions(el.terminalTargetSelect, state.targets, state.selectedId,
      'No managed terminals', (target) => `${target.title} · ${target.type}${target.busy ? ' · running' : ''}`);
    setOptions(el.machineAttachTarget, state.targets, el.machineAttachTarget.value,
      'No managed terminals', (target) => `${target.title} · ${target.cwd}`);
    const target = activeTarget();
    el.terminalTargetStatus.textContent = target
      ? `${target.title} · ${target.cwd}${target.busy ? ' · command running' : ' · ready'}`
      : 'Create a Nexus-managed terminal. Existing external terminals are not attached.';
    el.connectTerminalTarget.disabled = !connected() || !target;
    el.stopTerminalTarget.disabled = !connected() || !target;
    el.interruptTerminal.disabled = !connected() || !target?.busy;
    syncBaseMode();
    renderRoom();
  }
  function syncBaseMode() {
    const active = isMachine();
    el.terminalTargetControls.hidden = !active;
    if (!active) { el.terminalRelayPanel.hidden = false; return; }
    el.onlineTargetControls.hidden = true;
    el.localTargetControls.hidden = true;
    if (el.appTargetControls) el.appTargetControls.hidden = true;
    el.terminalRelayPanel.hidden = true;
    const target = activeTarget();
    el.bridgeBadge.textContent = connected() ? 'Terminal bridge ready' : 'Nexus reconnecting';
    el.bridgeBadge.classList.toggle('online', connected());
    el.bridgeBadge.classList.toggle('offline', !connected());
    el.targetStatus.textContent = target ? `Bound to managed terminal: ${target.title}` : 'No managed terminal selected.';
    el.prompt.placeholder = target ? `Enter a ${target.type} command. Local allow-once approval is required.` : 'Create and select a managed terminal first.';
    el.sendPrompt.textContent = target ? `Run in ${target.title}` : 'Run command';
    el.sendPrompt.disabled = !connected() || !target || target.busy;
    el.captureLatest.hidden = false;
    el.captureLatest.disabled = !target;
    el.captureLatest.textContent = 'Explain output history';
  }

  function decide(prepared, room = false) {
    const scope = room ? `Dex Machine Space command from ${prepared.actorName || 'agent'}` : 'Base Mode terminal command';
    const warning = `${scope}\n\nTerminal: ${prepared.terminalId || prepared.targetId}\nFolder: ${prepared.cwd || activeTarget()?.cwd || 'managed session folder'}\nRisk: ${prepared.risk}\n\n${prepared.command}`;
    if (!globalThis.confirm(`${warning}\n\nAllow this exact command once?`)) return { decision: 'deny', challenge: '' };
    if (prepared.risk !== 'high') return { decision: 'allow-once', challenge: '' };
    const entered = globalThis.prompt(`${warning}\n\nHigh-risk command. Type challenge ${prepared.challenge} to allow once.`, '');
    return entered == null ? { decision: 'deny', challenge: '' }
      : { decision: 'allow-once', challenge: String(entered).trim() };
  }
  function prepareBase() {
    const command = el.prompt.value.trim(), target = activeTarget();
    if (!command || !target) return message('system', target ? 'Enter a command first.' : 'Create and select a managed terminal first.');
    const id = requestId(); commandText.set(id, command);
    if (!send({ type: 'machine_prepare_command', requestId: id, targetId: target.id, command }))
      message('system', 'Nexus is not connected; the command was not prepared.');
  }
  function prepared(msg) {
    const choice = decide(msg);
    if (choice.decision === 'allow-once') {
      message('user', commandText.get(msg.requestId) || msg.command, `user-${msg.requestId}`);
      if (el.prompt.value.trim() === commandText.get(msg.requestId)) el.prompt.value = '';
    }
    send({ type: 'machine_approve_command', approvalId: msg.approvalId, ...choice });
    commandText.delete(msg.requestId);
  }
  function outputPage(msg) {
    const prior = outputs.get(msg.outputId);
    const text = msg.offset > 0 && prior?.nextOffset === msg.offset ? `${prior.text || ''}${msg.text || ''}` : (msg.text || '');
    const page = { ...(prior || {}), ...msg, text }; outputs.set(msg.outputId, page);
    const node = message('assistant', text || `(no ${msg.stream || 'combined'} output)`, `output-${msg.requestId}`);
    node.dataset.machineOutputId = msg.outputId;
    let more = node.querySelector('[data-machine-more]');
    more?.remove();
    if (msg.nextOffset != null) {
      more = document.createElement('button'); more.type = 'button'; more.className = 'secondary';
      more.dataset.machineMore = '1'; more.textContent = `Load more (${msg.nextOffset}/${msg.totalChars})`;
      more.addEventListener('click', () => send({ type: 'machine_output_page', outputId: msg.outputId,
        offset: msg.nextOffset, stream: msg.stream }));
      node.append(more);
    }
    renderRoom();
  }

  function currentRoomId() { return el.dexRoomList?.querySelector('.dex-room-item.active')?.dataset.roomId || ''; }
  function requestRoom() {
    const next = currentRoomId();
    if (next !== state.roomId) { state.roomId = next; state.room = null; }
    if (next && connected()) send({ type: 'machine_room_snapshot', roomId: next });
    renderRoom();
  }
  const humanInput = () => el.dexModePanel?.dataset.humanInput === 'enabled';
  function activeSpace() {
    return state.room?.spaces?.find((space) => space.id === el.machineSpaceSelect.value && !space.archived)
      || state.room?.spaces?.find((space) => !space.archived) || null;
  }
  function actionButton(text, action, { danger = false, disabled = false } = {}) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    button.className = `secondary${danger ? ' danger' : ''}`; button.disabled = disabled;
    button.addEventListener('click', action); return button;
  }
  function renderRoom() {
    const spaces = (state.room?.spaces || []).filter((space) => !space.archived);
    const wanted = el.machineSpaceSelect.value;
    setOptions(el.machineSpaceSelect, spaces, wanted, 'No Machine Spaces', (space) => space.name);
    const space = activeSpace(), editable = humanInput();
    el.machineCreateSpace.disabled = !state.roomId || !editable;
    el.machineArchiveSpace.disabled = !space || !editable;
    el.machineAttach.disabled = !space || !state.targets.length || !editable;
    el.machineSpaceStatus.textContent = !state.roomId ? 'Choose a room to inspect its Machine Spaces.'
      : !space ? 'No active Machine Space. Enable Human Input to create one.'
        : `${space.name} · ${(space.resources || []).length} terminal resource(s) · ${(space.requests || []).length} request(s)`;
    el.machineSpaceResources.replaceChildren();
    for (const resource of space?.resources || []) {
      const card = document.createElement('div'); card.className = 'machine-resource';
      const head = document.createElement('div'); head.className = 'machine-resource-head';
      const title = document.createElement('div'); title.className = 'machine-resource-title';
      title.textContent = resource.available ? `${resource.title} · ${resource.type}` : `${resource.id} · unavailable`;
      head.append(title, actionButton('Detach', () => {
        if (globalThis.confirm(`Detach ${resource.title || resource.id} from ${space.name}?`))
          send({ type: 'machine_detach_target', roomId: state.roomId, spaceId: space.id, targetId: resource.id });
      }, { danger: true, disabled: !editable }));
      const meta = document.createElement('div'); meta.className = 'machine-meta';
      meta.textContent = resource.cwd || 'Managed session is no longer running.';
      card.append(head, meta); el.machineSpaceResources.append(card);
    }
    if (!space?.resources?.length) el.machineSpaceResources.innerHTML = '<div class="machine-empty">No managed terminals attached.</div>';
    el.machineSpaceRequests.replaceChildren();
    for (const request of [...(space?.requests || [])].reverse()) renderRequest(space, request);
    if (!space?.requests?.length) el.machineSpaceRequests.innerHTML = '<div class="machine-empty">No agent terminal requests yet.</div>';
  }
  function renderRequest(space, request) {
    const card = document.createElement('div'); card.className = 'machine-request';
    const head = document.createElement('div'); head.className = 'machine-request-head';
    const title = document.createElement('div'); title.className = 'machine-request-title';
    title.textContent = `${request.actorName || 'Agent'} · ${request.terminalId}`;
    const badge = document.createElement('span'); badge.className = `machine-state-${request.state}`; badge.textContent = request.state;
    head.append(title, badge);
    const command = document.createElement('pre'); command.className = 'machine-request-command';
    command.textContent = request.command || request.commandSummary || '(command unavailable)';
    const meta = document.createElement('div'); meta.className = 'machine-meta';
    meta.textContent = `${request.risk || 'recorded'}${request.exitCode == null ? '' : ` · exit ${request.exitCode}`}${request.bytes == null ? '' : ` · ${request.bytes} bytes`}`;
    const actions = document.createElement('div'); actions.className = 'machine-request-actions';
    if (request.state === 'approval-required') {
      actions.append(actionButton('Allow once', () => {
        const choice = decide(request, true);
        send({ type: 'machine_approve_command', approvalId: request.approvalId, ...choice });
      }), actionButton('Deny', () => send({ type: 'machine_approve_command', approvalId: request.approvalId,
        decision: 'deny' }), { danger: true }));
    }
    if (request.outputId) actions.append(actionButton('View output', () => send({ type: 'machine_output_page',
      roomId: state.roomId, outputId: request.outputId, offset: 0, stream: 'combined' })));
    const cached = outputs.get(request.outputId);
    card.append(head, command, meta, actions);
    if (cached) {
      const output = document.createElement('pre'); output.className = 'machine-output';
      output.textContent = cached.text || '(no terminal output)'; card.append(output);
    } else if (request.preview) {
      const preview = document.createElement('pre'); preview.className = 'machine-output'; preview.textContent = request.preview;
      card.append(preview);
    }
    el.machineSpaceRequests.append(card);
  }

  function handle(msg) {
    if (msg.type === 'machine_targets_update') {
      state.targets = Array.isArray(msg.targets) ? msg.targets : [];
      state.types = Array.isArray(msg.targetTypes) ? msg.targetTypes : [];
      state.selectedId = msg.selectedTarget?.id || (state.targets.some((item) => item.id === state.selectedId) ? state.selectedId : '');
      renderTargets(); return;
    }
    if (msg.type === 'machine_command_prepared') return prepared(msg);
    if (msg.type === 'machine_command_started') { message('system', `Command started in ${msg.targetId}.`, `status-${msg.requestId}`); return; }
    if (msg.type === 'machine_command_complete') {
      message('system', `Command ${msg.state}${msg.exitCode == null ? '' : ` · exit ${msg.exitCode}`}.`, `status-${msg.requestId}`);
      send({ type: 'machine_output_page', outputId: msg.outputId, offset: 0, stream: 'combined' }); return;
    }
    if (msg.type === 'machine_output_page') return outputPage(msg);
    if (msg.type === 'machine_room_snapshot') { if (msg.roomId === state.roomId) { state.room = msg; renderRoom(); } return; }
    if (msg.type === 'machine_command_denied') { message('system', 'Command denied; nothing executed.', `status-${msg.requestId}`); requestRoom(); return; }
    if (msg.type === 'machine_space_created') { requestRoom(); return; }
    if (msg.type === 'error' && String(msg.code || '').startsWith('MACHINE_')) {
      message('system', `${msg.code}: ${msg.message}`); requestRoom();
    }
  }
  function connect() {
    if (socket) return;
    socket = socketApi.createClient({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      hello: { type: 'hello', role: 'ui' }, onMessage: handle,
      onOpen: () => { send({ type: 'request_machine_targets', ownerId }); requestRoom(); },
      onPhase: ({ phase }) => { state.phase = phase; syncBaseMode(); },
      onMalformed: (error) => message('system', `Machine Spaces received malformed data: ${error.message}`)
    });
    socket.connect();
  }
  function disconnect() { socket?.stop(); socket = null; state.phase = 'suspended'; syncBaseMode(); }

  el.targetClassSelect.addEventListener('change', () => { syncBaseMode(); if (isMachine()) send({ type: 'request_machine_targets', ownerId }); });
  el.refreshTerminalTargets.addEventListener('click', () => send({ type: 'request_machine_targets', ownerId }));
  el.createTerminalTarget.addEventListener('click', () => send({ type: 'machine_create_target',
    targetType: el.terminalTypeSelect.value, label: el.terminalLabel.value, cwd: el.terminalCwd.value }));
  el.connectTerminalTarget.addEventListener('click', () => send({ type: 'machine_select_target', targetId: el.terminalTargetSelect.value }));
  el.terminalTargetSelect.addEventListener('change', () => { state.selectedId = el.terminalTargetSelect.value; renderTargets(); });
  el.stopTerminalTarget.addEventListener('click', () => {
    const target = activeTarget();
    if (target && globalThis.confirm(`Stop ${target.title} and detach it from all Machine Spaces?`))
      send({ type: 'machine_stop_target', targetId: target.id });
  });
  el.interruptTerminal.addEventListener('click', () => {
    const target = activeTarget();
    if (target && globalThis.confirm(`Interrupt the running command in ${target.title}? Its outcome will be marked unknown.`))
      send({ type: 'machine_interrupt', targetId: target.id });
  });
  el.sendPrompt.addEventListener('click', (event) => { if (isMachine()) { event.preventDefault(); event.stopImmediatePropagation(); prepareBase(); } }, true);
  el.prompt.addEventListener('keydown', (event) => {
    if (isMachine() && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation(); prepareBase();
    }
  }, true);
  el.captureLatest.addEventListener('click', (event) => {
    if (isMachine()) { event.preventDefault(); event.stopImmediatePropagation(); message('system', 'Terminal output is retained in bounded pages beside each command. Select Load more when available.'); }
  }, true);
  el.machineSpaceSelect.addEventListener('change', renderRoom);
  el.machineCreateSpace.addEventListener('click', () => {
    const name = globalThis.prompt('Machine Space name', 'Machine Space');
    if (name) send({ type: 'machine_create_space', roomId: state.roomId, name });
  });
  el.machineArchiveSpace.addEventListener('click', () => {
    const space = activeSpace();
    if (space && globalThis.confirm(`Archive ${space.name}? Terminal outputs remain bounded local records.`))
      send({ type: 'machine_archive_space', roomId: state.roomId, spaceId: space.id });
  });
  el.machineAttach.addEventListener('click', () => {
    const space = activeSpace(), targetId = el.machineAttachTarget.value;
    if (space && targetId && globalThis.confirm('Attach this managed terminal to the selected room Machine Space?'))
      send({ type: 'machine_attach_target', roomId: state.roomId, spaceId: space.id, targetId });
  });
  new MutationObserver(() => requestRoom()).observe(el.dexRoomList, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  new MutationObserver(renderRoom).observe(el.dexModePanel, { attributes: true, attributeFilter: ['data-human-input'] });
  const client = { snapshot: () => ({ selectedId: state.selectedId, roomId: state.roomId }),
    restore: (value) => { if (value?.selectedId) state.selectedId = value.selectedId; }, resume: connect, suspend: disconnect };
  globalThis.BrowserAiBridgeMachineSpacesUi = { prepareBase, explainOutput: () => message('system', 'Terminal output is retained in bounded pages beside each command. Select Load more when available.') };
  if (handoff) handoff.register('machine-spaces', client); else connect();
  syncBaseMode(); renderRoom();
})();
