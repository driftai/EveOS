'use strict';

const { randomUUID } = require('node:crypto');
const { createSupervisedJobCoordinator } = require('./supervised-job');
const { createSupervisedJobProviderControl, ACTIONS } = require('./supervised-job-provider-control');
const { findSpace } = require('./server-controller-filesystem');
const dexProtocol = require('../public/dex-protocol');
for (const action of ACTIONS) dexProtocol.PROVIDER_CONTROL_ACTIONS.add(action);

function machineError(code, message) { return Object.assign(new Error(message), { code }); }

function enhanceMachineSpacesSupervisedController(createBaseController, options = {}) {
  const uiSockets = options.uiSockets || new Set();
  const safeSend = options.safeSend || (() => false);
  const getState = options.getState || (() => null);
  const base = createBaseController(options);
  const jobs = options.supervisedJobs || createSupervisedJobCoordinator({ now: options.now });
  const commandStore = options.supervisedCommandStore || new Map();
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
      .map((job) => ({ ...job, commandAvailable: commandStore.has(job.jobId) }));
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
          totalBytes: result.totalBytes, outputTruncated: result.outputTruncated === true
        }
      });
      commandStore.delete(jobId);
      broadcastJobs('settled', [settled]);
    } catch {}
  }
  function startLocal(ws, msg) {
    requireLocal(ws);
    const current = jobs.status(msg.jobId);
    if (current.state !== 'queued') throw machineError('MACHINE_JOB_STATE_CONFLICT', `Job is ${current.state}; queued is required for first launch.`);
    const stored = commandStore.get(current.jobId);
    if (!stored?.command) throw machineError('MACHINE_JOB_COMMAND_UNAVAILABLE', 'The prepared command is no longer available. Do not replay it; prepare a new job only after confirming this one never launched.');
    const target = base.broker.target(current.targetId);
    if (!target || target.processEpoch !== current.processEpoch)
      throw machineError('MACHINE_JOB_TARGET_EPOCH_MISMATCH', 'The prepared terminal was replaced before launch.');
    const sessionId = localSession(ws);
    const running = jobs.start(current.jobId, { sessionId, targetId: target.id, processEpoch: target.processEpoch });
    const run = base.broker.runSupervised({
      targetId: target.id, processEpoch: target.processEpoch, requestId: current.requestId, command: stored.command,
      onStart(detail) { safeSend(ws, { type: 'machine_supervised_job_started', job: jobs.status(current.jobId), process: detail }); }
    });
    run.then((result) => settleFromProcess(current.jobId, result), (error) => settleFromProcess(current.jobId, null, error));
    broadcastJobs('started', [running]);
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
      if (!base.broker.interrupt(current.targetId))
        return jobs.settle(current.jobId, { state: 'outcome-unknown', reason: 'interrupt-not-confirmed', errorCode: 'MACHINE_JOB_INTERRUPT_UNCONFIRMED' });
      return jobs.status(current.jobId);
    }
    const cancelled = jobs.cancel(current.jobId, { reason: 'cancelled-by-local-owner' });
    commandStore.delete(current.jobId); broadcastJobs('cancelled', [cancelled]); return cancelled;
  }

  const jobControl = createSupervisedJobProviderControl({ jobs, commandStore, broker: base.broker, getState,
    findSpace: (room, reference) => findSpace(room, reference) });
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
      if (type === 'machine_supervised_jobs') {
        requireLocal(ws); localSession(ws);
        safeSend(ws, { type: 'machine_supervised_jobs', reason: 'snapshot', jobs: visible(msg.roomId || null, msg.spaceId || null) });
        return true;
      }
      if (type === 'machine_start_supervised_job') {
        const job = startLocal(ws, msg); safeSend(ws, { type: 'machine_supervised_job_changed', action: 'started', job }); return true;
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
      if (['queued', 'running', 'deferred'].includes(job.state)) jobs.terminalizeForTarget(job.targetId, job.processEpoch, 'nexus-stopped');
    }
    previousStop?.();
  }

  return { ...base, handle, providerControl, supervisedJobs: jobs, supervisedCommandStore: commandStore, jobControl, stop };
}

module.exports = { enhanceMachineSpacesSupervisedController };
