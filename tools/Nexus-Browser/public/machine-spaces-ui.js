(() => {
  'use strict';
  const socketApi = globalThis.BrowserAiBridgeUiSocket;
  const handoff = globalThis.BrowserAiBridgeWorkspaceHandoff;
  if (!socketApi) throw new Error('Machine Spaces requires the shared UI socket helper.');
  const dialog = globalThis.BrowserAiBridgeMachineDialog;
  if (!dialog) throw new Error('Machine Spaces requires the in-page dialog helper.');

  const byId = (id) => document.getElementById(id);
  const el = Object.fromEntries([
    'targetClassSelect','onlineTargetControls','localTargetControls','appTargetControls','terminalTargetControls',
    'terminalTypeSelect','terminalLabel','terminalCwd','terminalTargetSelect','refreshTerminalTargets',
    'createTerminalTarget','connectTerminalTarget','interruptTerminal','stopTerminalTarget','terminalTargetStatus',
    'terminalRelayPanel','bridgeBadge','targetStatus','prompt','captureLatest','sendPrompt','transcript',
    'dexModePanel','dexRoomList','machineCreateSpace','machineArchiveSpace','machineSpaceSelect',
    'machineAttachTarget','machineAttach','machineSpaceStatus','machineSpaceResources','machineSpaceRequests',
    'machineNewTerminalType','machineNewTerminalCwd','machineNewTerminal','machineRefreshTerminals'
  ].map((id) => [id, byId(id)]));
  const state = { phase: 'connecting', targets: [], types: [], selectedId: '', roomId: '', room: null };
  const outputs = new Map(), commandText = new Map();
  const OWNER_KEY = 'browser-ai-bridge.machine-owner.v1';
  const FILE_READ_CAPS = Object.freeze(['files.list', 'files.stat', 'files.read', 'files.search']);
  const FILE_EDIT_CAPS = Object.freeze([...FILE_READ_CAPS, 'files.create', 'files.write', 'files.patch', 'files.move', 'files.delete']);
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
      const label = document.createElement('div'); label.className = 'message-label';
      label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Managed terminal' : 'System';
      const body = document.createElement('div'); body.className = 'message-body';
      node.append(label, body); el.transcript?.append(node);
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
      const option = document.createElement('option'); option.value = item.id; option.textContent = label(item); select.append(option);
    }
    const next = items.some((item) => item.id === value) ? value : items[0].id;
    select.value = next; return next;
  }
  function renderTargets() {
    const oldType = el.terminalTypeSelect.value;
    setOptions(el.terminalTypeSelect, state.types, oldType, 'No terminal types', (item) => item.name);
    setOptions(el.machineNewTerminalType, state.types, el.machineNewTerminalType.value, 'No terminal types', (item) => item.name);
    state.selectedId = setOptions(el.terminalTargetSelect, state.targets, state.selectedId,
      'No managed terminals', (target) => `${target.title} · ${target.type}${target.busy ? ' · running' : ''}`);
    setOptions(el.machineAttachTarget, state.targets, el.machineAttachTarget.value,
      'No managed terminals yet: create one', (target) => `${target.title} · ${target.type} · ${target.cwd}${target.busy ? ' · running' : ''}`);
    const target = activeTarget();
    el.terminalTargetStatus.textContent = target
      ? `${target.title} · ${target.cwd}${target.busy ? ' · command running' : ' · ready'}`
      : 'Create a Nexus-managed terminal. Existing external terminals are not attached.';
    el.connectTerminalTarget.disabled = !connected() || !target;
    el.stopTerminalTarget.disabled = !connected() || !target;
    el.interruptTerminal.disabled = !connected() || !target?.busy;
    syncBaseMode(); renderRoom();
  }
  function syncBaseMode() {
    const active = isMachine();
    el.terminalTargetControls.hidden = !active;
    if (!active) { el.terminalRelayPanel.hidden = false; return; }
    el.onlineTargetControls.hidden = true; el.localTargetControls.hidden = true;
    if (el.appTargetControls) el.appTargetControls.hidden = true;
    el.terminalRelayPanel.hidden = true;
    const target = activeTarget();
    el.bridgeBadge.textContent = connected() ? 'Terminal bridge ready' : 'Nexus reconnecting';
    el.bridgeBadge.classList.toggle('online', connected()); el.bridgeBadge.classList.toggle('offline', !connected());
    el.targetStatus.textContent = target ? `Bound to managed terminal: ${target.title}` : 'No managed terminal selected.';
    el.prompt.placeholder = target ? `Enter a ${target.type} command. Local allow-once approval is required.` : 'Create and select a managed terminal first.';
    el.sendPrompt.textContent = target ? `Run in ${target.title}` : 'Run command';
    el.sendPrompt.disabled = !connected() || !target || target.busy;
    el.captureLatest.hidden = false; el.captureLatest.disabled = !target; el.captureLatest.textContent = 'Explain output history';
  }

  async function decide(prepared, room = false) {
    const scope = room ? `Dex Machine Space command from ${prepared.actorName || 'agent'}` : 'Base Mode terminal command';
    const warning = `Terminal: ${prepared.terminalId || prepared.targetId}\nFolder: ${prepared.cwd || activeTarget()?.cwd || 'managed session folder'}\nRisk: ${prepared.risk}\n\n${prepared.command}`;
    if (!(await dialog.confirm(`${scope}: allow this exact command once?`, warning, { confirmText: 'Allow once', cancelText: 'Deny' })))
      return { decision: 'deny', challenge: '' };
    if (prepared.risk !== 'high') return { decision: 'allow-once', challenge: '' };
    const entered = await dialog.prompt(`High-risk command. Type challenge ${prepared.challenge} to allow once.`, '',
      { body: warning, confirmText: 'Allow once', danger: true });
    return entered == null ? { decision: 'deny', challenge: '' } : { decision: 'allow-once', challenge: String(entered).trim() };
  }
  function prepareBase() {
    const command = el.prompt.value.trim(), target = activeTarget();
    if (!command || !target) return message('system', target ? 'Enter a command first.' : 'Create and select a managed terminal first.');
    const id = requestId(); commandText.set(id, command);
    if (!send({ type: 'machine_prepare_command', requestId: id, targetId: target.id, command }))
      message('system', 'Nexus is not connected; the command was not prepared.');
  }
  async function prepared(msg) {
    const choice = await decide(msg);
    if (choice.decision === 'allow-once') {
      message('user', commandText.get(msg.requestId) || msg.command, `user-${msg.requestId}`);
      if (el.prompt.value.trim() === commandText.get(msg.requestId)) el.prompt.value = '';
    }
    send({ type: 'machine_approve_command', approvalId: msg.approvalId, ...choice }); commandText.delete(msg.requestId);
  }
  function outputPage(msg) {
    const prior = outputs.get(msg.outputId);
    const text = msg.offset > 0 && prior?.nextOffset === msg.offset ? `${prior.text || ''}${msg.text || ''}` : (msg.text || '');
    const page = { ...(prior || {}), ...msg, text }; outputs.set(msg.outputId, page);
    const node = message('assistant', text || `(no ${msg.stream || 'combined'} output)`, `output-${msg.requestId}`);
    node.dataset.machineOutputId = msg.outputId;
    node.querySelector('[data-machine-more]')?.remove();
    if (msg.nextOffset != null) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'secondary';
      more.dataset.machineMore = '1'; more.textContent = `Load more (${msg.nextOffset}/${msg.totalChars})`;
      more.addEventListener('click', () => send({ type: 'machine_output_page', outputId: msg.outputId, offset: msg.nextOffset, stream: msg.stream }));
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
    button.className = `secondary${danger ? ' danger' : ''}`; button.disabled = disabled; button.addEventListener('click', action); return button;
  }
  async function enableRepoGrant(space, resource) {
    const body = [
      `Repository will be resolved from: ${resource.cwd || '(unknown folder)'}`, '',
      'Auto-run only: git pull --ff-only, git fetch/status/log/diff, npm test, node --test, and bounded read-only PowerShell Get-Location/Get-ChildItem/Get-Content inside that repo.', '',
      'Still requires explicit approval: restart/kill commands, git push/reset/clean/branch switching, deletes, installs, shell chaining/substitution, and anything outside the repo.', '',
      'Existing 30 second runtime and 1 MiB output caps remain in force.'
    ].join('\n');
    if (await dialog.confirm(`Enable persistent repo-safe agent grant for ${space.name}?`, body,
      { confirmText: 'Enable grant', cancelText: 'Cancel' }))
      send({ type: 'machine_enable_repo_grant', roomId: state.roomId, spaceId: space.id, targetId: resource.id });
  }
  async function revokeRepoGrant(space) {
    if (await dialog.confirm(`Revoke the repo-safe grant for ${space.name}?`,
      'Future agent terminal commands will return to one-time approval unless another local grant is enabled.',
      { confirmText: 'Revoke grant', cancelText: 'Keep grant', danger: true }))
      send({ type: 'machine_revoke_repo_grant', roomId: state.roomId, spaceId: space.id });
  }
  async function enableFileGrant(space, resource, mode, capabilities, label) {
    const persistent = mode === 'persistent';
    const body = [
      `Repository root is resolved from managed terminal: ${resource.cwd || '(unknown folder)'}`,
      `Target: ${resource.title || resource.id}`,
      `Mode: ${persistent ? 'persistent (8 hour default expiry)' : 'allow once (consumed by the first attempted operation)'}`,
      `Capabilities: ${capabilities.join(', ')}`,
      '',
      'Paths remain repository-relative, canonicalized, symlink-escape protected and bounded. Existing-file mutations require the exact current SHA-256 hash; writes are atomic.',
      '',
      'This filesystem grant is separate from the terminal repo-safe grant and does not authorize shell commands.'
    ].join('\n');
    if (await dialog.confirm(`${label} for ${space.name}?`, body,
      { confirmText: persistent ? 'Enable grant' : 'Allow once', cancelText: 'Cancel', danger: capabilities.includes('files.delete') }))
      send({ type: 'machine_enable_file_grant', roomId: state.roomId, spaceId: space.id, targetId: resource.id,
        ownerId, mode, capabilities });
  }
  async function revokeFileGrant(space, grant) {
    if (await dialog.confirm(`Revoke filesystem grant ${grant.id}?`,
      `${grant.capabilities?.join(', ') || 'No capabilities'}\n${grant.repoRoot || ''}`,
      { confirmText: 'Revoke grant', cancelText: 'Keep grant', danger: true }))
      send({ type: 'machine_revoke_file_grant', roomId: state.roomId, spaceId: space.id, grantId: grant.id });
  }
  function grantCard(space, editable) {
    if (!space?.grant?.enabled) return null;
    const card = document.createElement('div'); card.className = 'machine-resource';
    const head = document.createElement('div'); head.className = 'machine-resource-head';
    const title = document.createElement('div'); title.className = 'machine-resource-title'; title.textContent = 'Repo-safe terminal grant · enabled';
    head.append(title, actionButton('Revoke grant', () => revokeRepoGrant(space), { danger: true, disabled: !editable }));
    const meta = document.createElement('div'); meta.className = 'machine-meta';
    meta.textContent = `${space.grant.policy} · scope ${space.grant.repoRoot} · created ${space.grant.createdAt || 'locally'}`;
    card.append(head, meta); return card;
  }
  function fileGrantCard(space, grant, editable) {
    const card = document.createElement('div'); card.className = 'machine-resource';
    const head = document.createElement('div'); head.className = 'machine-resource-head';
    const title = document.createElement('div'); title.className = 'machine-resource-title';
    title.textContent = `Filesystem grant · ${grant.enabled ? grant.mode : grant.revokedReason || 'inactive'}`;
    head.append(title, actionButton('Revoke', () => revokeFileGrant(space, grant), { danger: true, disabled: !editable || !grant.enabled }));
    const meta = document.createElement('div'); meta.className = 'machine-meta';
    meta.textContent = `${grant.capabilities?.join(', ') || 'no capabilities'} · ${grant.repoRoot || ''} · target ${grant.targetId || ''} · expires ${grant.expiresAt || 'n/a'}${grant.usesRemaining == null ? '' : ` · ${grant.usesRemaining} use remaining`}`;
    card.append(head, meta); return card;
  }
  function renderRoom() {
    const spaces = (state.room?.spaces || []).filter((space) => !space.archived);
    setOptions(el.machineSpaceSelect, spaces, el.machineSpaceSelect.value, 'No Machine Spaces', (space) => space.name);
    const space = activeSpace(), editable = humanInput();
    el.machineCreateSpace.disabled = !state.roomId || !editable; el.machineArchiveSpace.disabled = !space || !editable;
    el.machineAttach.disabled = !space || !state.targets.length || !editable;
    el.machineNewTerminal.disabled = !connected() || !state.types.length || !editable; el.machineRefreshTerminals.disabled = !connected();
    el.machineSpaceStatus.textContent = !state.roomId ? 'Choose a room to inspect its Machine Spaces.'
      : !space ? 'No active Machine Space. Enable Human Input to create one.'
        : `${space.name} · ${(space.resources || []).length} terminal resource(s) · ${(space.requests || []).length} terminal request(s) · ${(space.fileRequests || []).length} file request(s) · ${(space.fileGrants || []).filter((g) => g.enabled).length} active file grant(s)${space.grant?.enabled ? ' · repo-safe terminal grant on' : ''}`;
    el.machineSpaceResources.replaceChildren();
    const terminalGrant = grantCard(space, editable); if (terminalGrant) el.machineSpaceResources.append(terminalGrant);
    for (const fileGrant of space?.fileGrants || []) el.machineSpaceResources.append(fileGrantCard(space, fileGrant, editable));
    for (const resource of space?.resources || []) {
      const card = document.createElement('div'); card.className = 'machine-resource';
      const head = document.createElement('div'); head.className = 'machine-resource-head';
      const title = document.createElement('div'); title.className = 'machine-resource-title';
      title.textContent = resource.available ? `${resource.title} · ${resource.type}` : `${resource.id} · unavailable`;
      const actions = document.createElement('div'); actions.className = 'machine-request-actions';
      if (!space.grant?.enabled && resource.available) actions.append(actionButton('Terminal repo-safe', () => enableRepoGrant(space, resource), { disabled: !editable }));
      if (resource.available) {
        actions.append(
          actionButton('Files once', () => enableFileGrant(space, resource, 'once', FILE_EDIT_CAPS, 'Allow one filesystem operation'), { disabled: !editable }),
          actionButton('Persistent read', () => enableFileGrant(space, resource, 'persistent', FILE_READ_CAPS, 'Enable persistent read-only filesystem grant'), { disabled: !editable }),
          actionButton('Persistent edit', () => enableFileGrant(space, resource, 'persistent', FILE_EDIT_CAPS, 'Enable persistent filesystem edit grant'), { disabled: !editable })
        );
      }
      actions.append(actionButton('Detach', async () => {
        if (await dialog.confirm(`Detach ${resource.title || resource.id} from ${space.name}?`, 'Target-scoped filesystem grants will be revoked.', { confirmText: 'Detach', danger: true }))
          send({ type: 'machine_detach_target', roomId: state.roomId, spaceId: space.id, targetId: resource.id });
      }, { danger: true, disabled: !editable }));
      head.append(title, actions);
      const meta = document.createElement('div'); meta.className = 'machine-meta'; meta.textContent = resource.cwd || 'Managed session is no longer running.';
      card.append(head, meta); el.machineSpaceResources.append(card);
    }
    if (!space?.resources?.length && !terminalGrant && !(space?.fileGrants || []).length)
      el.machineSpaceResources.innerHTML = '<div class="machine-empty">No managed terminals attached.</div>';
    renderRequests(space);
  }
  const LIVE_STATES = new Set(['approval-required', 'queued', 'running']);
  let historyOpen = false;
  function renderRequests(space) {
    el.machineSpaceRequests.replaceChildren();
    const terminalRequests = [...(space?.requests || [])].map((request) => ({ ...request, requestKind: 'terminal' }));
    const fileRequests = [...(space?.fileRequests || [])].map((request) => ({ ...request, requestKind: 'filesystem' }));
    const requests = [...terminalRequests, ...fileRequests].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    if (!requests.length) { el.machineSpaceRequests.innerHTML = '<div class="machine-empty">No agent machine requests yet.</div>'; return; }
    const pinned = requests.filter((request, index) => index === 0 || LIVE_STATES.has(request.state));
    const history = requests.filter((request) => !pinned.includes(request));
    for (const request of pinned) el.machineSpaceRequests.append(renderRequest(space, request));
    if (!history.length) return;
    const details = document.createElement('details'); details.className = 'machine-request-history'; details.open = historyOpen;
    details.addEventListener('toggle', () => { historyOpen = details.open; });
    const summary = document.createElement('summary'); summary.textContent = `Earlier requests (${history.length})`;
    const list = document.createElement('div'); list.className = 'machine-request-list';
    for (const request of history) list.append(renderRequest(space, request));
    details.append(summary, list); el.machineSpaceRequests.append(details);
  }
  function renderRequest(space, request) {
    const card = document.createElement('div'); card.className = 'machine-request';
    const head = document.createElement('div'); head.className = 'machine-request-head';
    const title = document.createElement('div'); title.className = 'machine-request-title';
    title.textContent = request.requestKind === 'filesystem'
      ? `${request.actorName || 'Agent'} · ${request.capability || 'filesystem'} · ${request.terminalId}`
      : `${request.actorName || 'Agent'} · ${request.terminalId}`;
    const badge = document.createElement('span'); badge.className = `machine-state-${request.state}`; badge.textContent = request.state;
    head.append(title, badge);
    const command = document.createElement('pre'); command.className = 'machine-request-command';
    command.textContent = request.requestKind === 'filesystem'
      ? request.operationSummary || '(filesystem operation unavailable)'
      : request.command || request.commandSummary || '(command unavailable)';
    const meta = document.createElement('div'); meta.className = 'machine-meta';
    if (request.requestKind === 'filesystem') {
      meta.textContent = `grant ${request.grantId || 'none'} · digest ${String(request.operationDigest || '').slice(0, 12)}${request.errorCode ? ` · ${request.errorCode}` : ''}${request.resultSummary ? ` · ${request.resultSummary}` : ''}`;
    } else {
      const approval = request.approvalMode === 'repo-safe-v1'
        ? `repo-safe auto-approved for ${request.approvedByName || request.actorName || 'agent'}` : (request.risk || 'recorded');
      meta.textContent = `${approval}${request.exitCode == null ? '' : ` · exit ${request.exitCode}`}${request.bytes == null ? '' : ` · ${request.bytes} bytes`}`;
    }
    const actions = document.createElement('div'); actions.className = 'machine-request-actions';
    if (request.requestKind !== 'filesystem' && request.state === 'approval-required') {
      actions.append(actionButton('Allow once', async () => {
        const choice = await decide(request, true); send({ type: 'machine_approve_command', approvalId: request.approvalId, ...choice });
      }), actionButton('Deny', () => send({ type: 'machine_approve_command', approvalId: request.approvalId, decision: 'deny' }), { danger: true }));
    }
    if (request.outputId) actions.append(actionButton('View output', () => send({ type: 'machine_output_page',
      roomId: state.roomId, outputId: request.outputId, offset: 0, stream: 'combined' })));
    const cached = outputs.get(request.outputId);
    card.append(head, command, meta, actions);
    if (cached) {
      const output = document.createElement('pre'); output.className = 'machine-output'; output.textContent = cached.text || '(no terminal output)'; card.append(output);
    } else if (request.preview) {
      const preview = document.createElement('pre'); preview.className = 'machine-output'; preview.textContent = request.preview; card.append(preview);
    }
    return card;
  }

  function handle(msg) {
    if (msg.type === 'machine_targets_update') {
      state.targets = Array.isArray(msg.targets) ? msg.targets : []; state.types = Array.isArray(msg.targetTypes) ? msg.targetTypes : [];
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
    if (msg.type === 'machine_space_created' || msg.type === 'machine_file_grant_changed') { requestRoom(); return; }
    if (msg.type === 'error' && String(msg.code || '').startsWith('MACHINE_')) { message('system', `${msg.code}: ${msg.message}`); requestRoom(); }
  }
  function connect() {
    if (socket) return;
    socket = socketApi.createClient({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      hello: { type: 'hello', role: 'ui' }, onMessage: handle,
      onOpen: () => { send({ type: 'request_machine_targets', ownerId }); requestRoom(); },
      onPhase: ({ phase }) => { state.phase = phase; syncBaseMode(); },
      onMalformed: (error) => message('system', `Machine Spaces received malformed data: ${error.message}`)
    }); socket.connect();
  }
  function disconnect() { socket?.stop(); socket = null; state.phase = 'suspended'; syncBaseMode(); }

  el.targetClassSelect.addEventListener('change', () => { syncBaseMode(); if (isMachine()) send({ type: 'request_machine_targets', ownerId }); });
  el.refreshTerminalTargets.addEventListener('click', () => send({ type: 'request_machine_targets', ownerId }));
  el.createTerminalTarget.addEventListener('click', () => send({ type: 'machine_create_target', targetType: el.terminalTypeSelect.value, label: el.terminalLabel.value, cwd: el.terminalCwd.value }));
  el.connectTerminalTarget.addEventListener('click', () => send({ type: 'machine_select_target', targetId: el.terminalTargetSelect.value }));
  el.terminalTargetSelect.addEventListener('change', () => { state.selectedId = el.terminalTargetSelect.value; renderTargets(); });
  el.stopTerminalTarget.addEventListener('click', async () => {
    const target = activeTarget();
    if (target && await dialog.confirm(`Stop ${target.title} and detach it from all Machine Spaces?`, '', { confirmText: 'Stop', danger: true }))
      send({ type: 'machine_stop_target', targetId: target.id });
  });
  el.interruptTerminal.addEventListener('click', async () => {
    const target = activeTarget();
    if (target && await dialog.confirm(`Interrupt the running command in ${target.title}?`, 'Its outcome will be marked unknown.', { confirmText: 'Interrupt', danger: true }))
      send({ type: 'machine_interrupt', targetId: target.id });
  });
  el.sendPrompt.addEventListener('click', (event) => { if (isMachine()) { event.preventDefault(); event.stopImmediatePropagation(); prepareBase(); } }, true);
  el.prompt.addEventListener('keydown', (event) => { if (isMachine() && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); prepareBase(); } }, true);
  el.captureLatest.addEventListener('click', (event) => {
    if (isMachine()) { event.preventDefault(); event.stopImmediatePropagation(); message('system', 'Terminal output is retained in bounded pages beside each command. Select Load more when available.'); }
  }, true);
  el.machineSpaceSelect.addEventListener('change', renderRoom);
  el.machineCreateSpace.addEventListener('click', async () => {
    const roomId = state.roomId, name = String(await dialog.prompt('New Machine Space name', 'Machine Space', { confirmText: 'Create space' }) || '').trim();
    if (name && roomId) send({ type: 'machine_create_space', roomId, name });
  });
  el.machineArchiveSpace.addEventListener('click', async () => {
    const space = activeSpace();
    if (space && await dialog.confirm(`Archive ${space.name}?`, 'Terminal outputs remain bounded local records and active filesystem grants will be revoked.', { confirmText: 'Archive', danger: true }))
      send({ type: 'machine_archive_space', roomId: state.roomId, spaceId: space.id });
  });
  el.machineAttach.addEventListener('click', () => {
    const space = activeSpace(), targetId = el.machineAttachTarget.value;
    if (space && targetId) send({ type: 'machine_attach_target', roomId: state.roomId, spaceId: space.id, targetId });
  });
  el.machineRefreshTerminals.addEventListener('click', () => send({ type: 'request_machine_targets', ownerId }));
  el.machineNewTerminal.addEventListener('click', () => send({ type: 'machine_create_target', targetType: el.machineNewTerminalType.value, label: '', cwd: el.machineNewTerminalCwd.value }));
  new MutationObserver(() => requestRoom()).observe(el.dexRoomList, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  new MutationObserver(renderRoom).observe(el.dexModePanel, { attributes: true, attributeFilter: ['data-human-input'] });
  const client = { snapshot: () => ({ selectedId: state.selectedId, roomId: state.roomId }),
    restore: (value) => { if (value?.selectedId) state.selectedId = value.selectedId; }, resume: connect, suspend: disconnect };
  globalThis.BrowserAiBridgeMachineSpacesUi = { prepareBase, explainOutput: () => message('system', 'Terminal output is retained in bounded pages beside each command. Select Load more when available.') };
  if (handoff) handoff.register('machine-spaces', client); else connect();
  syncBaseMode(); renderRoom();
})();
