(() => {
  const MAX_EVENTS = 32;
  const FILTERS = Object.freeze([
    ['all', 'All'], ['decisions', 'Decisions'], ['receipts', 'Receipts'], ['attention', 'Needs attention']
  ]);

  function text(value, limit = 1200) {
    return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  }
  function enabled(room) {
    return (room?.members || []).filter((member) => member?.relayEnabled !== false && member?.binding);
  }
  function selectedMiddle(room) {
    const settings = room?.settings || {};
    if (settings.middleAgentMode === 'disabled') return null;
    const members = enabled(room), selected = text(settings.middleAgentMemberId, 128);
    if (selected) return members.find((member) => member.id === selected) || null;
    if (settings.middleAgentMode === 'manual') return null;
    const declared = members.filter((member) => member.engineeringRole === 'middle-agent');
    return declared.length === 1 ? declared[0] : members.length === 1 ? members[0] : null;
  }
  function stamp(value, fallback = 0) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function proposalEvent(message, member) {
    const proposal = message.engineeringProposal;
    if (!proposal) return null;
    const accepted = proposal.ok === true;
    const evidence = (proposal.requestedEvidence || []).map((item) => text(item, 180)).filter(Boolean);
    const repair = proposal.repair || {};
    return {
      id: `proposal:${message.id}`, kind: 'decision', tone: accepted ? 'decision' : 'attention', at: message.at,
      title: accepted ? 'Middle-agent engineering decision' : 'Middle-agent proposal rejected',
      summary: text(proposal.summary || proposal.message || message.text), member: member?.name || message.senderName || 'Middle agent',
      rows: [
        ['Evidence requested', evidence.join(' · ') || 'None requested'],
        ['Confidence', Number.isFinite(Number(proposal.confidence)) ? `${Math.round(Number(proposal.confidence) * 100)}%` : 'Not accepted'],
        ['Decision', text(repair.kind || proposal.code || 'none', 80)],
        ['Repair scope', (repair.paths || []).map((item) => text(item, 180)).join(', ') || 'No source paths'],
        ['Next step', text(proposal.retryIntent || repair.description || 'No retry requested', 500)]
      ],
      technical: { messageId: message.id, jobId: proposal.incidentJobId || null, schema: proposal.schema || null }
    };
  }
  function agentEvent(message, member) {
    const proposal = proposalEvent(message, member);
    if (proposal) return proposal;
    const completion = message.engineeringCompletion;
    return {
      id: `agent:${message.id}`, kind: completion ? 'decision' : 'update',
      tone: completion ? (completion.ok ? 'success' : 'attention') : 'neutral', at: message.at,
      title: completion ? (completion.ok ? 'Middle-agent completion verified' : 'Middle-agent completion rejected')
        : 'Middle-agent public reasoning update',
      summary: text(message.text, 1800) || 'No public summary was supplied.',
      member: member?.name || message.senderName || 'Middle agent',
      rows: completion ? [['Verification', completion.ok ? 'Accepted' : text(completion.code || 'Rejected')]] : [],
      technical: { messageId: message.id, finalReceipt: completion?.receipt || null }
    };
  }
  function incidentEvent(message, receipt, member) {
    const incident = message.engineeringIncident || {};
    const dispatch = receipt?.dispatch || 'recorded';
    const attention = ['safe-stopped', 'owner-required'].includes(dispatch)
      || ['failed', 'outcome-unknown'].includes(incident.state);
    return {
      id: `incident:${message.id}`, kind: 'trigger', tone: attention ? 'attention' : 'neutral', at: message.at,
      title: 'Engineering traffic entered the middle-agent lane',
      summary: text(`${incident.classification || 'engineering event'} · ${dispatch}`),
      member: member?.name || 'Unassigned',
      rows: [['Source', 'Machine Spaces'], ['Dispatch', dispatch],
        ['Outcome', text(incident.state || 'recorded')], ['Output evidence', incident.outputId ? 'Available by receipt' : 'Not attached']],
      technical: { messageId: message.id, jobId: incident.jobId, requestId: incident.requestId,
        outputId: incident.outputId, dispatchCode: receipt?.dispatchCode || null }
    };
  }
  function controlEvent(message, member) {
    const receipt = message.controlReceipt || {};
    return {
      id: `control:${message.id}`, kind: 'receipt', tone: receipt.ok ? 'success' : 'attention', at: message.at,
      title: `Control receipt · ${text(receipt.action || 'operation', 80)}`,
      summary: receipt.ok ? 'The requested control operation produced a durable result.'
        : `Control failed or was rejected: ${text(receipt.code || 'unknown error', 160)}`,
      member: member?.name || 'Middle agent', rows: [['Result', receipt.ok ? 'Confirmed' : 'Failed']],
      technical: { messageId: message.id, requestId: receipt.requestId, originMessageId: receipt.originMessageId,
        memberId: receipt.executorMemberId, code: receipt.code || null }
    };
  }
  function toolEvent(entry, member) {
    const uncertain = entry.state === 'outcome-unknown';
    return {
      id: `tool:${entry.requestId}`, kind: 'receipt', tone: uncertain ? 'attention' : 'neutral', at: entry.at,
      title: 'Local tool-result delivery', summary: `Receipt is ${text(entry.state || 'queued', 80)}.`,
      member: member?.name || 'Middle agent', rows: [['Delivery', text(entry.state || 'queued')]],
      technical: { requestId: entry.requestId, turnRequestId: entry.turnRequestId,
        targetId: entry.targetId, deliveryAttemptId: entry.deliveryAttemptId || null }
    };
  }
  function projectRoom(room) {
    const middle = selectedMiddle(room);
    const historicalIds = new Set((room?.engineeringIncidentReceipts || [])
      .map((entry) => entry.middleAgentMemberId).filter(Boolean));
    if (middle?.id) historicalIds.add(middle.id);
    const members = new Map((room?.members || []).map((member) => [member.id, member]));
    const messages = new Map((room?.messages || []).map((message) => [message.id, message]));
    const incidentReceipts = new Map((room?.engineeringIncidentReceipts || [])
      .map((entry) => [entry.messageId, entry]));
    const events = [];
    for (const [index, message] of (room?.messages || []).entries()) {
      let event = null;
      if (message.engineeringIncident) {
        const receipt = incidentReceipts.get(message.id);
        event = incidentEvent(message, receipt, members.get(receipt?.middleAgentMemberId));
      }
      else if (message.controlReceipt) {
        const origin = messages.get(message.controlReceipt.originMessageId);
        const memberId = message.controlReceipt.executorMemberId || origin?.senderId;
        if (historicalIds.has(memberId)) event = controlEvent(message, members.get(memberId));
      }
      else if (message.senderKind === 'agent' && historicalIds.has(message.senderId))
        event = agentEvent(message, members.get(message.senderId));
      if (event) events.push({ ...event, order: stamp(message.at, index) });
    }
    for (const [index, entry] of (room?.localToolResults || []).entries()) {
      if (historicalIds.has(entry.memberId)) {
        events.push({ ...toolEvent(entry, members.get(entry.memberId)), order: stamp(entry.at, 100000 + index) });
      }
    }
    const unique = new Map(events.map((event) => [event.id, event]));
    const ordered = [...unique.values()].sort((a, b) => b.order - a.order).slice(0, MAX_EVENTS);
    return {
      roomId: room?.id || null, mode: room?.settings?.middleAgentMode || 'automatic', middle,
      events: ordered, total: unique.size, attention: ordered.filter((event) => event.tone === 'attention').length,
      active: !!middle && (room?.relay?.waitingFor === middle.id || room?.recovery?.memberId === middle.id)
    };
  }
  function node(root, tag, className, value = '') {
    const item = root.createElement(tag); item.className = className; item.textContent = value; return item;
  }
  function create({ root = globalThis.document } = {}) {
    let filter = 'all';
    const status = root?.getElementById?.('dexMiddleAgentTrafficStatus');
    const filters = root?.getElementById?.('dexMiddleAgentTrafficFilters');
    const list = root?.getElementById?.('dexMiddleAgentTrafficList');
    if (!status || !filters || !list) return { render() {} };
    function matches(event) {
      if (filter === 'decisions') return event.kind === 'decision' || event.kind === 'update';
      if (filter === 'receipts') return event.kind === 'receipt';
      if (filter === 'attention') return event.tone === 'attention';
      return true;
    }
    function render(room) {
      const view = projectRoom(room);
      const label = view.middle ? `${view.middle.name || 'Middle agent'} · ${view.active ? 'working' : 'available'}`
        : view.mode === 'disabled' ? 'Disabled' : 'No unambiguous middle agent';
      status.textContent = label;
      filters.replaceChildren(...FILTERS.map(([value, title]) => {
        const button = node(root, 'button', `secondary${filter === value ? ' active' : ''}`, title);
        button.type = 'button'; button.dataset.filter = value;
        button.addEventListener('click', () => { filter = value; render(room); });
        return button;
      }));
      const visible = view.events.filter(matches);
      if (!visible.length) {
        list.replaceChildren(node(root, 'div', 'middle-traffic-empty', view.middle
          ? 'No matching middle-agent traffic has been recorded in this room.'
          : 'Select one enabled participant, or leave Automatic only when exactly one agent is eligible.'));
        return;
      }
      list.replaceChildren(...visible.map((event) => {
        const card = node(root, 'article', `middle-traffic-event tone-${event.tone}`);
        const heading = node(root, 'div', 'middle-traffic-event-head');
        heading.append(node(root, 'strong', '', event.title), node(root, 'span', 'middle-traffic-kind', event.kind));
        const summary = node(root, 'p', 'middle-traffic-summary', event.summary);
        const meta = node(root, 'div', 'middle-traffic-meta', `${event.member}${event.at ? ` · ${event.at}` : ''}`);
        card.append(heading, summary, meta);
        if (event.rows?.length) {
          const rows = node(root, 'dl', 'middle-traffic-rows');
          for (const [key, value] of event.rows) rows.append(node(root, 'dt', '', key), node(root, 'dd', '', value));
          card.append(rows);
        }
        const details = node(root, 'details', 'middle-traffic-technical');
        details.append(node(root, 'summary', '', 'Evidence and exact correlation'));
        details.append(node(root, 'pre', '', JSON.stringify(event.technical || {}, null, 2)));
        card.append(details); return card;
      }));
    }
    return { render };
  }

  const api = { MAX_EVENTS, selectedMiddle, projectRoom, create };
  globalThis.BrowserAiBridgeDexMiddleAgentTraffic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
