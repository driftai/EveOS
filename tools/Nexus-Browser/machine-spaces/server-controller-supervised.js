'use strict';

const { randomUUID } = require('node:crypto');
const { createSupervisedJobCoordinator } = require('./supervised-job');
const { inspectGovernorRuns } = require('./governor-run-inspect');
const { createSupervisedJobProviderControl, ACTIONS } = require('./supervised-job-provider-control');
const { findSpace } = require('./server-controller-model');
const { verifyPrepared } = require('./playwright-job-plan');
const { publicChatApproval, validateChatApproval, validateChatApprovalIntent } = require('./supervised-chat-approval');
const { createLocalPlanController } = require('./server-controller-local-plans');
const { recoveryProjection } = require('./engineering-recovery-result');
const { createSupervisedLiveView } = require('./supervised-live-view');
const schedulerState = require('../dex/server-scheduler-state');
const dexProtocol = require('../public/dex-protocol');
for (const action of ACTIONS) dexProtocol.PROVIDER_CONTROL_ACTIONS.add(action);

function machineError(code, message) { return Object.assign(new Error(message), { code }); }

function enhanceMachineSpacesSupervisedController(createBaseController, options = {}) {
  const uiSockets = options.uiSockets || new Set();
  const safeSend = options.safeSend || (() => false);
  const getState = options.getState || (() => null);
  const saveState = options.saveState || ((value) => value);
  const broadcastState = options.broadcastState || (() => {});
  const nowMs = options.now || (() => Date.now());
  const base = createBaseController(options);
  const jobs = options.supervisedJobs || createSupervisedJobCoordinator({ now: options.now });
  const commandStore = options.supervisedCommandStore || new Map();
  const governorReceiptReader = options.governorReceiptReader || inspectGovernorRuns;
  const onSupervisedJobSettled = options.onSupervisedJobSettled || (() => {});
  const liveView = options.supervisedLiveView || createSupervisedLiveView();
  const governorRoot = options.governorRoot || require('node:path').resolve(__dirname, '..', '..', '..');
  const sessions = new WeakMap();
  const hooked = new WeakSet();

  function localSession(ws) {
    let id = sessions.get(ws);
    if (!id) { id = `machine-ui-session-${randomUUID()}`; sessions.set(ws, id); }
    if (!hooked.has(ws) && typeof ws?.once === 'function') {
      hooked.add(ws);
      ws.once('close', () => {
        const deferred = jobs.terminalizeForSession(id, 'local-supervisor-disconnected');
        if (deferred.length) broadcastJobs('deferred', deferred);
      });
    }
    return id;
  }
  function requireLocal(ws) {
    if (!uiSockets.has(ws)) throw machineError('MACHINE_LOCAL_OWNER_REQUIRED', 'Only the local Machine Spaces owner can launch, interrupt, or rebound supervised jobs.');
  }
  function visible(roomId = null, spaceId = null) {
    return jobs.snapshot().jobs.filter((job) => (!roomId || job.roomId === roomId) && (!spaceId || job.spaceId === spaceId))
      .map((job) => {
        const stored = commandStore.get(job.jobId);
        const display = stored?.displayCommand || stored?.command || '';
        return { ...job, commandAvailable: !!stored,
          commandPreview: display ? (display.length > 180 ? `${display.slice(0, 177)}...` : display) : null,
          governor: stored?.governor || null, recovery: stored?.recovery || null,
          visibleTerminal: stored?.visibleTerminal === true,
          chatApproval: publicChatApproval(stored, nowMs) };
      });
  }
  function broadcastJobs(reason, changed = []) {
    const payload = { type: 'machine_supervised_jobs', reason, jobs: visible(), changed };
    for (const ws of uiSockets) safeSend(ws, payload);
  }
  function settleFromProcess(jobId, result, error = null) {
    let current;
    try { current = jobs.status(jobId); } catch { return; }
    if (['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(current.state)) return;
    const state = error ? 'failed' : result.state;
    const audience = current.roomId ? `room:${current.roomId}` : `owner:${current.ownerMemberId || 'local'}`;
    let outputId = null;
    if (result && (result.stdout || result.stderr)) {
      try {
        outputId = base.spool.store({ audience, requestId: current.requestId,
          stdout: result.stdout, stderr: result.stderr, state, exitCode: result.exitCode,
          startedAt: result.startedAt, finishedAt: result.finishedAt }).outputId;
      } catch {}
    }
    const lease = current.state === 'running' ? current.lease : null;
    try {
      const settled = jobs.settle(jobId, {
        state: ['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(state) ? state : 'failed',
        sessionId: lease?.holderSessionId,
        leaseId: lease?.leaseId,
        errorCode: error?.code || null,
        reason: error?.message || result?.reason || null,
        result: error ? null : {
          outputId, exitCode: result.exitCode, signal: result.signal, bytes: result.bytes,
          totalBytes: result.totalBytes, outputTruncated: result.outputTruncated === true,
          recovery: recoveryProjection(result)
        }
      });
      commandStore.delete(jobId);
      broadcastJobs('settled', [settled]);
      try { onSupervisedJobSettled(settled); } catch {}
    } catch {}
  }
  const localPlans = createLocalPlanController({ jobs, commandStore, broker: base.broker,
    getState, repoRoot: governorRoot, resolveHead: options.resolveSupervisedHead });

  function startLocal(ws, msg, authorization = null) {
    requireLocal(ws);
    const current = jobs.status(msg.jobId);
    if (current.state !== 'queued') throw machineError('MACHINE_JOB_STATE_CONFLICT', `Job is ${current.state}; queued is required for first launch.`);
    const stored = commandStore.get(current.jobId);
    if (!stored?.command) throw machineError('MACHINE_JOB_COMMAND_UNAVAILABLE', 'The prepared command is no longer available. Do not replay it; prepare a new job only after confirming this one never launched.');
    const target = base.broker.target(current.targetId);
    if (!target || target.processEpoch !== current.processEpoch)
      throw machineError('MACHINE_JOB_TARGET_EPOCH_MISMATCH', 'The prepared terminal was replaced before launch.');
    if (stored.kind === 'governor' || stored.kind === 'recovery') localPlans.revalidate(stored, target);
    if (stored.kind === 'playwright-acceptance' || current.kind === 'playwright-acceptance') {
      if (stored.kind !== current.kind)
        throw machineError('MACHINE_PLAYWRIGHT_PLAN_CHANGED', 'The queued Playwright job kind changed.');
      verifyPrepared({ stored, target, repoRoot: governorRoot });
    }
    const active = base.broker.activeInfo(target.id);
    if (active)
      throw machineError('MACHINE_TARGET_BUSY', `The managed terminal is already running ${active.mode || 'a command'}; the supervised job remains queued.`);
    const sessionId = localSession(ws);
    jobs.authorize(current.jobId, authorization || { method: 'local-ui-confirmation' });
    const running = jobs.start(current.jobId, { sessionId, targetId: target.id, processEpoch: target.processEpoch });
    let observer = null;
    if (stored.visibleTerminal === true) {
      try { observer = liveView.start({ jobId: current.jobId, command: stored.displayCommand || stored.command }); }
      catch { observer = null; }
    }
    const run = base.broker.runSupervised({
      targetId: target.id, processEpoch: target.processEpoch, requestId: current.requestId, command: stored.command,
      onStart(detail) { safeSend(ws, { type: 'machine_supervised_job_started', job: jobs.status(current.jobId), process: detail }); },
      onData(detail) { observer?.write(detail); }
    });
    run.then((result) => { observer?.finish(result); settleFromProcess(current.jobId, result); },
      (error) => { observer?.finish(null, error); settleFromProcess(current.jobId, null, error); });
    broadcastJobs('started', [running]);
    return running;
  }
  function approveFromChat(ws, msg) {
    requireLocal(ws);
    if (ws.clientKind !== 'machine-chat-approval')
      throw machineError('MACHINE_PLAYWRIGHT_CHAT_CLIENT_REQUIRED', 'Playwright chat approval requires the dedicated local Dex approval client.');
    let current;
    if (msg.approvalIntent) {
      const pending = jobs.snapshot().jobs.filter((job) => job.roomId === String(msg.roomId || '')
        && job.kind === 'playwright-acceptance' && job.state === 'queued');
      if (!pending.length)
        throw machineError('MACHINE_PLAYWRIGHT_CHAT_APPROVAL_NONE', 'This room has no pending Playwright request to approve.');
      if (pending.length !== 1)
        throw machineError('MACHINE_PLAYWRIGHT_CHAT_APPROVAL_AMBIGUOUS', 'This room has multiple pending Playwright requests; use the exact job-specific phrase.');
      current = jobs.status(pending[0].jobId);
    } else current = jobs.status(msg.jobId);
    const stored = commandStore.get(current.jobId);
    const sourceMessageId = `msg-playwright-approval-${randomUUID()}`;
    const authorization = msg.approvalIntent
      ? validateChatApprovalIntent({ message: msg, job: current, stored, now: nowMs })
      : validateChatApproval({ message: msg, job: current, stored, now: nowMs });
    const running = startLocal(ws, { jobId: current.jobId }, { ...authorization, sourceMessageId });
    let snapshot = getState();
    const room = (snapshot?.rooms || []).find((entry) => entry.id === current.roomId);
    if (room) {
      const at = new Date(nowMs()).toISOString();
      schedulerState.addMessage(room, { id: sourceMessageId, senderKind: 'user', senderId: 'user',
        senderName: String(room.userName || 'Local operator').slice(0, 48), text: authorization.approvedText, at });
      const receipt = schedulerState.addMessage(room, { id: `msg-playwright-start-${randomUUID()}`,
        senderKind: 'system', senderId: null, senderName: 'Machine Spaces',
        text: `Local chat approval bound to ${current.jobId} and consumed once; registered Playwright job started.`, at });
      receipt.playwrightApproval = { schema: 'eveos.machine-spaces.playwright-chat-receipt.v1',
        jobId: current.jobId, method: authorization.method,
        approvalDigest: authorization.approvalDigest, sourceMessageId };
      snapshot = saveState(snapshot); broadcastState(snapshot);
    }
    return running;
  }
  function reboundLocal(ws, msg) {
    requireLocal(ws);
    const current = jobs.status(msg.jobId);
    if (current.state !== 'deferred') throw machineError('MACHINE_JOB_STATE_CONFLICT', `Job is ${current.state}; only deferred work can rebound.`);
    const active = base.broker.activeInfo(current.targetId);
    const target = base.broker.target(current.targetId);
    if (!active || active.mode !== 'supervised' || active.requestId !== current.requestId || !target || target.processEpoch !== current.processEpoch)
      throw machineError('MACHINE_JOB_PROCESS_NOT_RUNNING', 'The original supervised process cannot be proven alive. Rebound refused; do not replay the command.');
    const rebound = jobs.rebound(current.jobId, { sessionId: localSession(ws), targetId: target.id, processEpoch: target.processEpoch });
    broadcastJobs('rebound', [rebound]);
    return rebound;
  }
  function cancelLocal(ws, msg) {
    requireLocal(ws);
    const current = jobs.status(msg.jobId);
    if (['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(current.state)) return current;
    const active = base.broker.activeInfo(current.targetId);
    if (active?.mode === 'supervised' && active.requestId === current.requestId) {
      if (!base.broker.interrupt(current.targetId)) {
        const lease = current.state === 'running' ? current.lease : null;
        const settled = jobs.settle(current.jobId, {
          state: 'outcome-unknown',
          sessionId: lease?.holderSessionId,
          leaseId: lease?.leaseId,
          reason: 'interrupt-not-confirmed',
          errorCode: 'MACHINE_JOB_INTERRUPT_UNCONFIRMED'
        });
        commandStore.delete(current.jobId);
        broadcastJobs('settled', [settled]);
        try { onSupervisedJobSettled(settled); } catch {}
        return settled;
      }
      return jobs.status(current.jobId);
    }
    const lease = current.state === 'running' ? current.lease : null;
    const cancelled = jobs.cancel(current.jobId, {
      reason: 'cancelled-by-local-owner',
      sessionId: lease?.holderSessionId,
      leaseId: lease?.leaseId
    });
    commandStore.delete(current.jobId); broadcastJobs('cancelled', [cancelled]);
    try { onSupervisedJobSettled(cancelled); } catch {}
    return cancelled;
  }

  const jobControl = createSupervisedJobProviderControl({ jobs, commandStore, broker: base.broker, getState,
    repoRoot: governorRoot, now: nowMs, findSpace: (room, reference) => findSpace(room, reference) });
  const providerControl = {
    owns(action) { const value = String(action || '').toLowerCase(); return jobControl.owns(value) || base.providerControl.owns(value); },
    route(input, helpers) {
      const action = String(input?.command?.action || '').toLowerCase();
      const outcome = jobControl.owns(action) ? jobControl.route(input, helpers) : base.providerControl.route(input, helpers);
      if (jobControl.owns(action)) broadcastJobs('provider-control');
      return outcome;
    }
  };

  async function handle(ws, msg = {}) {
    const type = String(msg.type || '');
    try {
      if (type === 'machine_prepare_governor_job') {
        requireLocal(ws); const job = localPlans.prepareGovernor(msg);
        safeSend(ws, { type: 'machine_governor_job_prepared', requestId: msg.requestId, job });
        broadcastJobs('governor-prepared', [job]);
        return true;
      }
      if (type === 'machine_prepare_recovery_job') {
        requireLocal(ws); const job = localPlans.prepareRecovery(msg);
        safeSend(ws, { type: 'machine_recovery_job_prepared', requestId: msg.requestId, job });
        broadcastJobs('recovery-prepared', [job]);
        return true;
      }
      if (type === 'machine_prepare_room_recovery') {
        requireLocal(ws); const job = localPlans.prepareRoomRecovery(msg);
        safeSend(ws, { type: 'machine_recovery_job_prepared', requestId: msg.requestId, job });
        broadcastJobs('room-recovery-prepared', [job]);
        return true;
      }
      if (type === 'machine_governor_receipts') {
        requireLocal(ws); localSession(ws);
        const evidence = governorReceiptReader();
        safeSend(ws, { type: 'machine_governor_receipts', requestId: msg.requestId || null, ...evidence });
        return true;
      }
      if (type === 'machine_supervised_jobs') {
        requireLocal(ws); localSession(ws);
        safeSend(ws, { type: 'machine_supervised_jobs', reason: 'snapshot', jobs: visible(msg.roomId || null, msg.spaceId || null) });
        return true;
      }
      if (type === 'machine_start_supervised_job') {
        const job = startLocal(ws, msg); safeSend(ws, { type: 'machine_supervised_job_changed', action: 'started', job }); return true;
      }
      if (type === 'machine_chat_approve_supervised_job') {
        const job = approveFromChat(ws, msg);
        safeSend(ws, { type: 'machine_supervised_job_changed', requestId: msg.requestId || null,
          action: 'started', approvalMethod: job.authorization?.method || null, job }); return true;
      }
      if (type === 'machine_rebound_supervised_job') {
        const job = reboundLocal(ws, msg); safeSend(ws, { type: 'machine_supervised_job_changed', action: 'rebound', job }); return true;
      }
      if (type === 'machine_cancel_supervised_job') {
        const job = cancelLocal(ws, msg); safeSend(ws, { type: 'machine_supervised_job_changed', action: 'cancel-requested', job }); return true;
      }
      if (uiSockets.has(ws)) localSession(ws);
      return base.handle(ws, msg);
    } catch (error) {
      safeSend(ws, { type: 'error', requestId: msg.requestId || null,
        code: error.code || 'MACHINE_SUPERVISED_CONTROL_FAILED', message: error.message });
      return true;
    }
  }

  const previousStop = base.stop?.bind(base);
  function stop() {
    for (const job of jobs.snapshot().jobs) {
      if (['queued', 'running', 'deferred'].includes(job.state)) {
        for (const settled of jobs.terminalizeForTarget(job.targetId, job.processEpoch, 'nexus-stopped')) {
          try { onSupervisedJobSettled(settled); } catch {}
        }
      }
    }
    previousStop?.();
  }

  return { ...base, handle, providerControl, supervisedJobs: jobs, supervisedCommandStore: commandStore, jobControl, stop };
}

module.exports = { enhanceMachineSpacesSupervisedController };
