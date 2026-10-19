(() => {
  'use strict';

  const requests = document.getElementById('machineSpaceRequests');
  const resources = document.getElementById('machineSpaceResources');
  const roomList = document.getElementById('dexRoomList');
  const spaceSelect = document.getElementById('machineSpaceSelect');
  const dexPanel = document.getElementById('dexModePanel');
  if (!requests || !resources || !roomList || !spaceSelect || !dexPanel) return;

  const section = document.createElement('details');
  section.className = 'machine-request-history';
  section.open = true;
  section.innerHTML = '<summary>Supervised jobs</summary><div class="machine-request-list" data-supervised-jobs></div>';
  resources.insertAdjacentElement('afterend', section);
  // Read-only engineering evidence is local owner status, never a Dex command.
  const governorPanel = document.createElement('details');
  governorPanel.className = 'machine-request-history';
  governorPanel.innerHTML = '<summary>Engineering Governor receipts (read-only)</summary><div class="machine-request-list" data-governor-evidence></div>';
  section.insertAdjacentElement('afterend', governorPanel);
  // Local-owner preparation only. Remote agents have no authority through this form.
  const governorPrepare = document.createElement('details');
  governorPrepare.className = 'machine-request-history';
  governorPrepare.innerHTML = `<summary>Prepare Governor supervised job (local owner)</summary>
    <form data-governor-prepare class="machine-request-list">
      <label>Run ID <input name="runId" placeholder="governor-001" required maxlength="64"></label>
      <label>Managed PowerShell target ID <input name="targetId" placeholder="terminal-powershell-..." required></label>
      <label>Expected 40-character Git HEAD <input name="expectedHead" required minlength="40" maxlength="40"></label>
      <label>Mission path under data/runtime <input name="mission" placeholder="data/runtime/mission.txt" required></label>
      <label>Tier <select name="tier"><option value="small">Small / low</option><option value="medium" selected>Medium</option><option value="complex">Complex / medium</option></select></label>
      <label>Allowed source files (one repository-relative path per line)
        <textarea name="allowedFiles" rows="3" required></textarea></label>
      <button type="submit" class="secondary">Prepare only — local Start still required</button>
      <div data-governor-prepare-status role="status"></div>
    </form>`;
  governorPanel.insertAdjacentElement('afterend', governorPrepare);
  const governorForm = governorPrepare.querySelector('[data-governor-prepare]');
  const governorFormStatus = governorPrepare.querySelector('[data-governor-prepare-status]');
  governorForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const roomId = activeRoomId(), spaceId = activeSpaceId();
    if (!editable() || !roomId || !spaceId || phase !== 'connected') {
      governorFormStatus.textContent = 'Enable Human Input and choose an active room/space.';
      return;
    }
    const data = new FormData(governorForm);
    const values = (name) => String(data.get(name) || '').trim();
    const allowedFiles = values('allowedFiles').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const ok = send({ type:'machine_prepare_governor_job',
      requestId:`governor-prepare-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      roomId, spaceId, targetId:values('targetId'), runId:values('runId'),
      mission:values('mission'), expectedHead:values('expectedHead'), tier:values('tier'), allowedFiles });
    governorFormStatus.textContent = ok ? 'Preparation requested. No model has started.' : 'Nexus is disconnected.';
  });
  const governorList = governorPanel.querySelector('[data-governor-evidence]');
  governorPanel.addEventListener('toggle', () => {
    if (governorPanel.open && socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'machine_governor_receipts' }));
  });
  const recoveryPrepare = document.createElement('details');
  recoveryPrepare.className = 'machine-request-history';
  recoveryPrepare.innerHTML = `<summary>Prepare TLO recovery job (local owner)</summary>
    <form data-recovery-prepare class="machine-request-list">
      <label>Run ID <input name="runId" placeholder="recovery-001" required maxlength="64"></label>
      <label>Managed PowerShell target ID <input name="targetId" placeholder="terminal-powershell-..." required></label>
      <label>Expected 40-character Git HEAD <input name="expectedHead" required minlength="40" maxlength="40"></label>
      <label>Exact PowerShell command <textarea name="command" rows="3" required></textarea></label>
      <label>Authorized repair files (one repository-relative path per line)
        <textarea name="repairFiles" rows="3" required></textarea></label>
      <label>Additional read-only context files (optional)
        <textarea name="contextFiles" rows="2"></textarea></label>
      <label>Invariants (optional, one per line)<textarea name="invariants" rows="2"></textarea></label>
      <label>Repair attempts <select name="maxAttempts"><option value="1" selected>1</option><option value="2">2</option><option value="3">3</option></select></label>
      <label><input name="retrySafe" type="checkbox" required> I confirm this exact command is idempotent and safe to rerun only after a verified authorized repair.</label>
      <label><input name="visibleTerminal" type="checkbox" checked> Open a visible read-only terminal view while the managed process runs.</label>
      <button type="submit" class="secondary">Prepare recovery — local Start still required</button>
      <div data-recovery-prepare-status role="status"></div>
    </form>`;
  governorPrepare.insertAdjacentElement('afterend', recoveryPrepare);
  const recoveryForm = recoveryPrepare.querySelector('[data-recovery-prepare]');
  const recoveryStatus = recoveryPrepare.querySelector('[data-recovery-prepare-status]');
  recoveryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const roomId = activeRoomId(), spaceId = activeSpaceId();
    if (!editable() || !roomId || !spaceId || phase !== 'connected') {
      recoveryStatus.textContent = 'Enable Human Input and choose an active room/space.'; return;
    }
    const data = new FormData(recoveryForm), value = (name) => String(data.get(name) || '').trim();
    const lines = (name) => value(name).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const ok = send({ type: 'machine_prepare_recovery_job',
      requestId: `recovery-prepare-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      roomId, spaceId, targetId: value('targetId'), runId: value('runId'),
      branch: 'eve/nexus-machine-spaces', expectedHead: value('expectedHead'),
      command: value('command'), repairFiles: lines('repairFiles'), contextFiles: lines('contextFiles'),
      invariants: lines('invariants'), maxAttempts: Number(value('maxAttempts') || 1), retrySafety: 'idempotent',
      visibleTerminal: data.get('visibleTerminal') === 'on' });
    recoveryStatus.textContent = ok ? 'Recovery authority queued for review. No command or model has started.' : 'Nexus is disconnected.';
  });
  const list = section.querySelector('[data-supervised-jobs]');
  let socket = null;
  let phase = 'connecting';
  let jobs = [];
  let reconnectTimer = null;
  const outputs = new Map();
  const dexPrompt = document.getElementById('dexPrompt');
  const dexSend = document.getElementById('dexSend');
  let lastRoomIntent = null;

  const activeRoomId = () => roomList.querySelector('.dex-room-item.active')?.dataset.roomId || '';
  const activeSpaceId = () => String(spaceSelect.value || '');
  const editable = () => dexPanel.dataset.humanInput === 'enabled';
  const send = (payload) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };
  async function prepareRoomIntent() {
    const parsed = globalThis.BrowserAiBridgeRoomRecoveryIntent?.parse(dexPrompt?.value || '');
    if (!parsed) return;
    const roomId = activeRoomId(), spaceId = activeSpaceId();
    if (!editable() || !roomId || !spaceId || phase !== 'connected') {
      recoveryStatus.textContent = 'Room message sent; preparation requires Human Input, an active Machine Space, and Nexus connectivity.';
      return;
    }
    const key = `${roomId}:${spaceId}:${parsed.scriptPath}`;
    const now = Date.now();
    if (lastRoomIntent?.key === key && now - lastRoomIntent.at < 1500) return;
    // Lock during the confirmation dialog; Enter and Send may both fire.
    lastRoomIntent = { key, at: now };
    const approved = await confirmAction('Confirm safe recovery for this script',
      `Script: ${parsed.scriptPath}\n\nI confirm this script is idempotent, safe to run again after a verified repair, and TLO may edit only that script. Preparation is inert; Start supervised is a second, separate confirmation.`,
      'Confirm retry safety');
    if (!approved) { lastRoomIntent = null; return; }
    if (activeRoomId() !== roomId || activeSpaceId() !== spaceId || !editable() || phase !== 'connected') {
      recoveryStatus.textContent = 'Room/space or Human Input state changed during confirmation; preparation cancelled.';
      return;
    }
    const id = globalThis.crypto?.randomUUID?.() || String(Date.now());
    const ok = send({ type: 'machine_prepare_room_recovery', requestId: `room-recovery:${id}`,
      runId: `room-${id}`, roomId, spaceId, scriptPath: parsed.scriptPath,
      visibleTerminal: true, retrySafeConfirmed: true });
    recoveryStatus.textContent = ok
      ? `Room recovery requested for ${parsed.scriptPath}. Review the exact queued job and press Start supervised.`
      : 'Room message continues normally, but Nexus disconnected before recovery preparation.';
  }
  dexSend?.addEventListener('click', prepareRoomIntent, true);
  dexPrompt?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) prepareRoomIntent();
  }, true);
  const short = (value, length = 12) => {
    const text = String(value || '');
    return text.length > length ? `${text.slice(0, length)}…` : text;
  };
  const button = (label, action, { danger = false, owner = true } = {}) => {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label;
    node.className = `secondary${danger ? ' danger' : ''}`;
    node.disabled = phase !== 'connected' || (owner && !editable());
    node.addEventListener('click', action);
    return node;
  };
  async function confirmAction(title, body, confirmText, danger = false) {
    const dialog = globalThis.BrowserAiBridgeMachineDialog;
    if (dialog?.confirm) return dialog.confirm(title, body, { confirmText, cancelText: 'Cancel', danger });
    return globalThis.confirm(`${title}\n\n${body}`);
  }
  function requestSnapshot() {
    const roomId = activeRoomId(), spaceId = activeSpaceId();
    if (!roomId || !spaceId || phase !== 'connected') { jobs = []; render(); return; }
    send({ type: 'machine_supervised_jobs', roomId, spaceId });
  }
  function requestMutation(type, job) {
    send({ type, requestId: `machine-supervised-ui-${globalThis.crypto?.randomUUID?.() || Date.now()}`, jobId: job.jobId });
  }
  function requestOutput(job, offset = 0) {
    if (!job.result?.outputId) return;
    send({ type: 'machine_output_page', roomId: activeRoomId(), outputId: job.result.outputId,
      offset, stream: 'combined' });
  }
  function renderJob(job) {
    const card = document.createElement('div'); card.className = 'machine-request';
    const head = document.createElement('div'); head.className = 'machine-request-head';
    const title = document.createElement('div'); title.className = 'machine-request-title';
    title.textContent = `Supervised · ${job.targetId || 'terminal'} · ${job.jobId}`;
    const badge = document.createElement('span'); badge.className = `machine-state-${job.state}`; badge.textContent = job.state;
    head.append(title, badge);

    const command = document.createElement('pre'); command.className = 'machine-request-command';
    command.textContent = job.commandAvailable === false
      ? '(prepared command no longer available)'
      : (job.commandPreview || `request ${job.requestId || 'unknown'} · command digest ${short(job.commandDigest, 20) || 'n/a'}`);

    const meta = document.createElement('div'); meta.className = 'machine-meta';
    meta.textContent = [
      `request ${job.requestId || 'n/a'}`,
      job.governor?.runId ? `Governor ${job.governor.runId} (${job.governor.tier})` : null,
      job.recovery?.runId ? `TLO recovery ${job.recovery.runId} · ${job.recovery.maxAttempts} repair attempt(s) · idempotent retry` : null,
      job.recovery?.worker?.name ? `worker ${job.recovery.worker.name} (${job.recovery.worker.providerId || 'provider unknown'})` : null,
      job.visibleTerminal ? 'visible read-only terminal view' : null,
      `epoch ${short(job.processEpoch, 18) || 'n/a'}`,
      job.reboundCount ? `rebound ${job.reboundCount}×` : null,
      job.reason || null,
      job.errorCode || null,
      job.result?.outputId ? `output ${short(job.result.outputId, 18)}` : null
    ].filter(Boolean).join(' · ');

    const actions = document.createElement('div'); actions.className = 'machine-request-actions';
    if (job.state === 'queued') {
      actions.append(button('Start supervised', async () => {
        const recoveryNotice = job.recovery
          ? `\n\nRecovery authority: TLO may edit only ${job.recovery.repairFiles.join(', ')}, run this same idempotent command again after a verified repair, and stop after ${job.recovery.maxAttempts} repair attempt(s).`
          : '';
        const terminalNotice = job.visibleTerminal ? '\n\nA visible read-only terminal will mirror the managed execution.' : '';
        const ok = await confirmAction('Start this supervised job?',
          'The exact prepared command will start in its pinned Nexus-managed terminal. It may remain running until stopped, completed, or the supervision ceiling is reached.' + recoveryNotice + terminalNotice,
          'Start job');
        if (ok) requestMutation('machine_start_supervised_job', job);
      }));
    } else if (job.state === 'deferred') {
      actions.append(button('Reattach supervision', async () => {
        const ok = await confirmAction('Reattach supervision?',
          'Nexus will only reattach if the original supervised process is still provably active with the same request ID and process epoch. It will not replay the command.',
          'Reattach');
        if (ok) requestMutation('machine_rebound_supervised_job', job);
      }));
    } else if (job.state === 'running') {
      actions.append(button('Interrupt', async () => {
        const ok = await confirmAction('Interrupt this supervised job?',
          'Interrupting a long-running process is treated as an uncertain terminal outcome, never as successful completion.',
          'Interrupt', true);
        if (ok) requestMutation('machine_cancel_supervised_job', job);
      }, { danger: true }));
    }
    if (job.result?.outputId) actions.append(button('View output', () => requestOutput(job), { owner: false }));
    card.append(head, command, meta, actions);

    const cached = job.result?.outputId ? outputs.get(job.result.outputId) : null;
    if (cached) {
      const output = document.createElement('pre'); output.className = 'machine-output'; output.textContent = cached.text || '(no terminal output)';
      card.append(output);
      if (cached.nextOffset != null) {
        card.append(button(`Load more (${cached.nextOffset}/${cached.totalChars})`, () => requestOutput(job, cached.nextOffset), { owner: false }));
      }
    }
    return card;
  }
  function render() {
    list.replaceChildren();
    if (!activeRoomId() || !activeSpaceId()) {
      list.innerHTML = '<div class="machine-empty">Choose a room and Machine Space to inspect supervised work.</div>';
      return;
    }
    if (phase !== 'connected') {
      list.innerHTML = '<div class="machine-empty">Supervised job controls are reconnecting.</div>';
      return;
    }
    const relevant = [...jobs].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    if (!relevant.length) {
      list.innerHTML = '<div class="machine-empty">No supervised jobs in this Machine Space.</div>';
      return;
    }
    for (const job of relevant) list.append(renderJob(job));
  }
  function handleOutput(payload) {
    const prior = outputs.get(payload.outputId);
    const text = payload.offset > 0 && prior?.nextOffset === payload.offset
      ? `${prior.text || ''}${payload.text || ''}` : (payload.text || '');
    outputs.set(payload.outputId, { ...prior, ...payload, text });
    render();
  }
  function handle(payload) {
    if (payload.type === 'machine_governor_job_prepared') {
      governorFormStatus.textContent = `Queued Governor job ${payload.job?.jobId || 'unknown'}. Click Start supervised to launch after review.`;
      requestSnapshot();
      return;
    }
    if (payload.type === 'machine_recovery_job_prepared') {
      recoveryStatus.textContent = `Queued TLO recovery job ${payload.job?.jobId || 'unknown'}. Review its command and repair authority, then click Start supervised.`;
      requestSnapshot(); return;
    }
    if (payload.type === 'machine_governor_receipts') {
      governorList.replaceChildren();
      const rows = Array.isArray(payload.runs) ? payload.runs.slice(0, 16) : [];
      if (!rows.length) {
        const empty = document.createElement('div'); empty.className = 'machine-empty';
        empty.textContent = `Engineering receipts: ${payload.state || 'unavailable'}. No job is started by this view.`;
        governorList.append(empty);
      }
      for (const entry of rows) {
        const row = document.createElement('div'); row.className = 'machine-request';
        row.textContent = [entry.runId, entry.state, entry.model || 'model unknown',
          entry.effort || 'effort unknown', entry.updatedAt || 'time unavailable',
          entry.published ? `published ${entry.published.slice(0, 12)}` : 'not published'
        ].join(' · ');
        governorList.append(row);
      }
      return;
    }
    if (payload.type === 'machine_supervised_jobs') {
      const roomId = activeRoomId(), spaceId = activeSpaceId();
      jobs = Array.isArray(payload.jobs)
        ? payload.jobs.filter((job) => (!roomId || job.roomId === roomId) && (!spaceId || job.spaceId === spaceId))
        : [];
      render();
      return;
    }
    if (payload.type === 'machine_output_page') { handleOutput(payload); return; }
    if (payload.type === 'machine_supervised_job_changed' || payload.type === 'machine_supervised_job_started') {
      requestSnapshot();
      return;
    }
    if (payload.type === 'error' && String(payload.code || '').startsWith('MACHINE_')) {
      const note = document.createElement('div'); note.className = 'machine-empty';
      note.textContent = `${payload.code}: ${payload.message}`; list.prepend(note);
    }
  }
  function connect() {
    clearTimeout(reconnectTimer);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws`);
    socket.addEventListener('open', () => {
      phase = 'connected';
      send({ type: 'hello', role: 'ui', clientKind: 'machine-supervised-jobs' });
      setTimeout(requestSnapshot, 50);
      if (governorPanel.open) send({ type: 'machine_governor_receipts' });
      render();
    });
    socket.addEventListener('message', (event) => {
      try { handle(JSON.parse(event.data)); } catch {}
    });
    socket.addEventListener('close', () => {
      phase = 'reconnecting'; socket = null; render();
      reconnectTimer = setTimeout(connect, 1000);
    });
    socket.addEventListener('error', () => {});
  }

  const observer = new MutationObserver(() => { render(); requestSnapshot(); });
  observer.observe(roomList, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  observer.observe(dexPanel, { attributes: true, attributeFilter: ['data-human-input'] });
  spaceSelect.addEventListener('change', requestSnapshot);
  section.addEventListener('toggle', () => { if (section.open) requestSnapshot(); });
  connect();
  render();
})();
