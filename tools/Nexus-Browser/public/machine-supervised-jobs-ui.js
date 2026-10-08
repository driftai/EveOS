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
  const list = section.querySelector('[data-supervised-jobs]');
  let socket = null;
  let phase = 'connecting';
  let jobs = [];
  let reconnectTimer = null;
  const outputs = new Map();

  const activeRoomId = () => roomList.querySelector('.dex-room-item.active')?.dataset.roomId || '';
  const activeSpaceId = () => String(spaceSelect.value || '');
  const editable = () => dexPanel.dataset.humanInput === 'enabled';
  const send = (payload) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };
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
      `epoch ${short(job.processEpoch, 18) || 'n/a'}`,
      job.reboundCount ? `rebound ${job.reboundCount}×` : null,
      job.reason || null,
      job.errorCode || null,
      job.result?.outputId ? `output ${short(job.result.outputId, 18)}` : null
    ].filter(Boolean).join(' · ');

    const actions = document.createElement('div'); actions.className = 'machine-request-actions';
    if (job.state === 'queued') {
      actions.append(button('Start supervised', async () => {
        const ok = await confirmAction('Start this supervised job?',
          'The exact prepared command will start in its pinned Nexus-managed terminal. It may remain running until stopped, completed, or the supervision ceiling is reached.',
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
