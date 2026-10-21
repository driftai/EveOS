(() => {
  const HUMAN = Object.freeze({
    'approval-pending': 'Approval needed', running: 'In progress', completed: 'Completed',
    failed: 'Failed', deferred: 'Deferred', cancelled: 'Cancelled',
    'outcome-unknown': 'Outcome unknown', 'owner-required': 'Owner action needed'
  });
  const PREPARE_ACTIONS = new Set(['workspace_ensure', 'terminal_exec', 'job_prepare', 'playwright_prepare', 'governor_prepare']);
  const READ_ACTIONS = new Set(['status', 'room_log', 'tool_result_status', 'terminal_targets', 'terminal_status', 'terminal_output', 'job_status', 'job_list']);

  function text(value, fallback = '') { return String(value ?? fallback).trim(); }
  function human(value) {
    const raw = text(value, 'update');
    return HUMAN[raw] || raw.replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function technical(message, fields) {
    const ids = Object.fromEntries(Object.entries(fields || {}).filter(([, value]) => text(value)));
    return { ids, raw: text(message?.text), json: JSON.stringify(ids, null, 2) };
  }
  function engineering(message) {
    const event = message?.engineeringIncident;
    if (!event) return null;
    const verified = message.engineeringVerification;
    const state = text(event.state, verified?.state || 'updated');
    const success = verified?.state === 'completed' && Number(verified.exitCode) === 0 && verified.outcome === 'GREEN';
    const uncertain = state === 'outcome-unknown' || state === 'deferred';
    const tone = success ? 'success' : uncertain ? 'warning' : state === 'failed' ? 'danger' : 'neutral';
    const title = success ? 'Engineering repair verified' : state === 'failed' ? 'Engineering job failed'
      : uncertain ? 'Engineering outcome needs confirmation' : `Engineering ${human(state)}`;
    const rows = [
      ['Task', human(event.classification || 'engineering work')],
      ['Action', human(state)],
      ['Test', event.exitCode == null ? 'No verified exit result in this receipt' : `Exit ${event.exitCode}`],
      ['Repair', success ? 'Verified GREEN' : event.recoveryOutcome ? human(event.recoveryOutcome) : 'No verified repair result'],
      ['Publication', event.publicationSha ? `Confirmed ${event.publicationSha}` : 'Not reported in this receipt'],
      ['Remaining', success ? 'None for this verified repair' : state === 'failed' ? 'Inspect evidence before proposing a correction' : uncertain ? 'Confirm the existing outcome; do not replay' : 'Follow the current job state']
    ];
    return { tone, label: success ? 'Verified success' : human(state), title, rows,
      technical: technical(message, { jobId: event.jobId, requestId: event.requestId, roomId: event.roomId,
        spaceId: event.spaceId, terminalId: event.targetId, outputId: event.outputId,
        receipt: verified?.receipt || event.recoveryReceipt, publicationSha: event.publicationSha }) };
  }
  function recoveryPrepared(message) {
    const value = message?.engineeringRecoveryPrepared;
    if (!value) return null;
    const running = value.state === 'running';
    return { tone: running ? 'neutral' : 'warning', label: running ? 'In progress' : 'Approval needed',
      title: running ? 'Engineering recovery started' : 'Engineering recovery prepared',
      rows: [['Task', 'Repair a confirmed engineering failure'], ['Action', running ? 'Running under the approved workflow' : 'Prepared without execution'],
        ['Test', 'Pending post-repair verification'], ['Repair', running ? 'In progress' : 'Waiting for owner approval'],
        ['Publication', 'Not yet confirmed'], ['Remaining', running ? 'Wait for the verified receipt' : 'Review and approve the exact bounded workflow']],
      technical: technical(message, value) };
  }
  function approval(message) {
    const value = message?.supervisedApproval;
    if (!value) return null;
    return { tone: 'neutral', label: 'Authorized', title: 'Workflow approved',
      rows: [['Task', 'Supervised Machine Spaces work'], ['Action', 'Authorization consumed exactly once'],
        ['Test', 'Not completed by approval alone'], ['Repair', 'Covered only when the bounded workflow permits it'],
        ['Publication', 'Not yet confirmed'], ['Remaining', 'Wait for execution and verification receipts']],
      technical: technical(message, value) };
  }
  function control(message) {
    const value = message?.controlReceipt;
    if (!value) return null;
    const action = text(value.action, 'control');
    const failed = value.ok !== true;
    const pending = !failed && PREPARE_ACTIONS.has(action);
    return { tone: failed ? 'danger' : pending ? 'warning' : 'neutral',
      label: failed ? 'Rejected' : pending ? 'Prepared' : READ_ACTIONS.has(action) ? 'Information' : 'Confirmed',
      title: failed ? `${human(action)} failed` : pending ? `${human(action)} accepted — not completed` : `${human(action)} receipt`,
      rows: [['Task', human(action)], ['Action', failed ? 'Rejected or failed' : pending ? 'Prepared or queued' : 'Control operation confirmed'],
        ['Test', 'Not a test result'], ['Repair', 'Not reported'], ['Publication', 'Not reported'],
        ['Remaining', failed ? human(value.code || 'Inspect the control error') : pending ? 'Wait for approval/execution evidence' : 'No additional control action implied']],
      technical: technical(message, { requestId: value.requestId, roomId: value.roomId,
        memberId: value.executorMemberId, originMessageId: value.originMessageId, code: value.code }) };
  }
  function relayFailure(message) {
    if (message?.relayFailure !== true) return null;
    return { tone: 'danger', label: 'Delivery failure', title: 'Dex relay failed',
      rows: [['Task', 'Deliver the agent turn'], ['Action', 'Stopped safely'], ['Test', 'No successful delivery receipt'],
        ['Repair', 'Not attempted'], ['Publication', 'Not applicable'], ['Remaining', 'Resolve the reported transport/provider condition before retrying']],
      technical: technical(message, { sourceMessageId: message.sourceMessageId, turnRequestId: message.turnRequestId }) };
  }
  function completion(message) {
    const value = message?.engineeringCompletion;
    if (!value) return null;
    return { tone: value.ok ? 'success' : 'danger', label: value.ok ? 'Verified success' : 'Completion rejected',
      title: value.ok ? 'Engineering completion independently verified' : 'Engineering completion was not accepted',
      rows: [['Task', 'Close the engineering workflow'], ['Action', value.ok ? 'Evidence binding accepted' : 'Stopped without a GREEN claim'],
        ['Test', value.ok ? 'Verified GREEN receipt' : human(value.code)], ['Repair', value.ok ? 'Confirmed' : 'Unverified'],
        ['Publication', 'Only confirmed when a publication SHA is present'], ['Remaining', value.ok ? 'None for this verification receipt' : 'Supply the missing server-owned evidence']],
      technical: technical(message, value) };
  }
  function present(message) {
    return completion(message) || engineering(message) || recoveryPrepared(message) || approval(message)
      || control(message) || relayFailure(message) || null;
  }

  const api = { present, human };
  globalThis.BrowserAiBridgeDexReceiptPresentation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
