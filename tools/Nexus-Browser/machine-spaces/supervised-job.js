'use strict';

const { randomUUID } = require('node:crypto');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'outcome-unknown']);
const ACTIVE_STATES = new Set(['queued', 'running', 'deferred']);

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function text(value) { return String(value ?? '').trim(); }
function makeError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function createSupervisedJobCoordinator(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => randomUUID();
  const leaseTtlMs = Math.max(5000, Number(options.leaseTtlMs) || 120000);
  const maxJobs = Math.max(16, Number(options.maxJobs) || 256);
  const jobs = new Map();
  const requestIndex = new Map();
  const events = [];
  let sequence = 0;

  function stamp() { return new Date(now()).toISOString(); }
  function record(type, job, extra = {}) {
    events.push({ sequence: ++sequence, type, at: stamp(), jobId: job.jobId, requestId: job.requestId, ...clone(extra) });
    if (events.length > 2000) events.splice(0, events.length - 2000);
  }
  function exact(jobId) {
    const job = jobs.get(text(jobId));
    if (!job) throw makeError('MACHINE_JOB_NOT_FOUND', `Unknown supervised job: ${jobId}`);
    return job;
  }
  function publicJob(job) {
    return clone({
      jobId: job.jobId, requestId: job.requestId, kind: job.kind, state: job.state,
      roomId: job.roomId, spaceId: job.spaceId, ownerMemberId: job.ownerMemberId,
      targetId: job.targetId, processEpoch: job.processEpoch, commandDigest: job.commandDigest,
      createdAt: job.createdAt, startedAt: job.startedAt, deferredAt: job.deferredAt,
      finishedAt: job.finishedAt, lease: job.lease ? {
        leaseId: job.lease.leaseId, holderSessionId: job.lease.holderSessionId,
        expiresAt: job.lease.expiresAt, generation: job.lease.generation
      } : null,
      result: job.result, errorCode: job.errorCode, reason: job.reason,
      reboundCount: job.reboundCount
    });
  }
  function prune() {
    if (jobs.size <= maxJobs) return;
    const terminal = [...jobs.values()].filter((job) => TERMINAL_STATES.has(job.state))
      .sort((a, b) => Date.parse(a.finishedAt || a.createdAt) - Date.parse(b.finishedAt || b.createdAt));
    while (jobs.size > maxJobs && terminal.length) {
      const removed = terminal.shift();
      jobs.delete(removed.jobId);
      if (requestIndex.get(removed.requestId) === removed.jobId) requestIndex.delete(removed.requestId);
    }
  }

  function create(input = {}) {
    const requestId = text(input.requestId);
    if (!requestId) throw makeError('MACHINE_JOB_REQUEST_REQUIRED', 'requestId is required for exact-once supervised jobs.');
    const existingId = requestIndex.get(requestId);
    if (existingId) {
      const existing = exact(existingId);
      const same = text(input.commandDigest) === existing.commandDigest
        && text(input.targetId) === existing.targetId
        && text(input.processEpoch) === existing.processEpoch;
      if (!same) throw makeError('MACHINE_JOB_REQUEST_CONFLICT', 'This requestId already owns a different supervised job.');
      return publicJob(existing);
    }
    const targetId = text(input.targetId), processEpoch = text(input.processEpoch);
    if (!targetId || !processEpoch) throw makeError('MACHINE_JOB_TARGET_REQUIRED', 'A trusted targetId and processEpoch are required.');
    const job = {
      jobId: `machine-job-${idFactory()}`, requestId,
      kind: text(input.kind) || 'terminal', state: 'queued',
      roomId: text(input.roomId) || null, spaceId: text(input.spaceId) || null,
      ownerMemberId: text(input.ownerMemberId) || null,
      targetId, processEpoch, commandDigest: text(input.commandDigest) || null,
      createdAt: stamp(), startedAt: null, deferredAt: null, finishedAt: null,
      lease: null, result: null, errorCode: null, reason: null, reboundCount: 0
    };
    jobs.set(job.jobId, job); requestIndex.set(requestId, job.jobId); prune();
    record('created', job);
    return publicJob(job);
  }

  function issueLease(job, sessionId) {
    const lease = {
      leaseId: `job-lease-${idFactory()}`,
      holderSessionId: text(sessionId),
      expiresAt: new Date(now() + leaseTtlMs).toISOString(),
      generation: (job.lease?.generation || 0) + 1
    };
    job.lease = lease;
    return lease;
  }
  function leaseValid(job, leaseId, sessionId) {
    return job.lease && job.lease.leaseId === text(leaseId)
      && job.lease.holderSessionId === text(sessionId)
      && Date.parse(job.lease.expiresAt) > now();
  }

  function start(jobId, input = {}) {
    const job = exact(jobId);
    if (job.state !== 'queued') {
      if (job.state === 'running' && leaseValid(job, input.leaseId, input.sessionId)) return publicJob(job);
      throw makeError('MACHINE_JOB_STATE_CONFLICT', `Job ${job.jobId} is ${job.state}, not queued.`);
    }
    if (text(input.targetId || job.targetId) !== job.targetId || text(input.processEpoch || job.processEpoch) !== job.processEpoch)
      throw makeError('MACHINE_JOB_TARGET_EPOCH_MISMATCH', 'Managed terminal identity changed before supervised job start.');
    const sessionId = text(input.sessionId);
    if (!sessionId) throw makeError('MACHINE_JOB_SESSION_REQUIRED', 'A supervising sessionId is required.');
    issueLease(job, sessionId); job.state = 'running'; job.startedAt = stamp();
    record('started', job, { leaseId: job.lease.leaseId, sessionId });
    return publicJob(job);
  }

  function defer(jobId, input = {}) {
    const job = exact(jobId);
    if (TERMINAL_STATES.has(job.state)) return publicJob(job);
    if (job.state !== 'running') throw makeError('MACHINE_JOB_STATE_CONFLICT', `Job ${job.jobId} is ${job.state}, not running.`);
    if (!leaseValid(job, input.leaseId, input.sessionId))
      throw makeError('MACHINE_JOB_LEASE_INVALID', 'Only the current supervising session may defer this job.');
    job.state = 'deferred'; job.deferredAt = stamp(); job.reason = text(input.reason) || 'session-disconnected';
    job.lease = null;
    record('deferred', job, { reason: job.reason });
    return publicJob(job);
  }

  function rebound(jobId, input = {}) {
    const job = exact(jobId);
    if (job.state !== 'deferred') throw makeError('MACHINE_JOB_STATE_CONFLICT', `Job ${job.jobId} is ${job.state}, not deferred.`);
    if (text(input.targetId || job.targetId) !== job.targetId || text(input.processEpoch || job.processEpoch) !== job.processEpoch)
      throw makeError('MACHINE_JOB_TARGET_EPOCH_MISMATCH', 'Refusing rebound because the trusted terminal process epoch changed.');
    const sessionId = text(input.sessionId);
    if (!sessionId) throw makeError('MACHINE_JOB_SESSION_REQUIRED', 'A new supervising sessionId is required.');
    issueLease(job, sessionId); job.state = 'running'; job.reboundCount += 1; job.reason = null;
    record('rebound', job, { leaseId: job.lease.leaseId, sessionId, reboundCount: job.reboundCount });
    return publicJob(job);
  }

  function settle(jobId, input = {}) {
    const job = exact(jobId);
    if (TERMINAL_STATES.has(job.state)) {
      const same = job.state === input.state && JSON.stringify(job.result) === JSON.stringify(input.result ?? null);
      if (same) return publicJob(job);
      throw makeError('MACHINE_JOB_ALREADY_SETTLED', `Job ${job.jobId} already settled as ${job.state}.`);
    }
    if (!['running', 'deferred', 'queued'].includes(job.state))
      throw makeError('MACHINE_JOB_STATE_CONFLICT', `Job ${job.jobId} cannot settle from ${job.state}.`);
    const state = text(input.state);
    if (!TERMINAL_STATES.has(state)) throw makeError('MACHINE_JOB_TERMINAL_STATE_REQUIRED', 'Settlement must be completed, failed, cancelled, or outcome-unknown.');
    if (job.state === 'running' && !leaseValid(job, input.leaseId, input.sessionId))
      throw makeError('MACHINE_JOB_LEASE_INVALID', 'Running job settlement requires the current supervision lease.');
    job.state = state; job.result = clone(input.result ?? null); job.errorCode = text(input.errorCode) || null;
    job.reason = text(input.reason) || job.reason; job.finishedAt = stamp(); job.lease = null;
    record('settled', job, { state, errorCode: job.errorCode, reason: job.reason });
    return publicJob(job);
  }

  function cancel(jobId, input = {}) {
    const job = exact(jobId);
    if (TERMINAL_STATES.has(job.state)) return publicJob(job);
    return settle(jobId, { state: 'cancelled', reason: text(input.reason) || 'cancelled-by-owner',
      leaseId: input.leaseId, sessionId: input.sessionId });
  }

  function terminalizeForSession(sessionId, reason = 'session-stopped') {
    const id = text(sessionId), changed = [];
    for (const job of jobs.values()) {
      if (job.state === 'running' && job.lease?.holderSessionId === id) {
        job.state = 'deferred'; job.deferredAt = stamp(); job.reason = reason; job.lease = null;
        record('deferred', job, { reason }); changed.push(publicJob(job));
      }
    }
    return changed;
  }

  function terminalizeForTarget(targetId, processEpoch = null, reason = 'target-stopped') {
    const id = text(targetId), epoch = text(processEpoch), changed = [];
    for (const job of jobs.values()) {
      if (!ACTIVE_STATES.has(job.state) || job.targetId !== id || (epoch && job.processEpoch !== epoch)) continue;
      job.state = 'outcome-unknown'; job.reason = reason; job.errorCode = 'MACHINE_JOB_TARGET_LOST'; job.finishedAt = stamp(); job.lease = null;
      record('settled', job, { state: job.state, errorCode: job.errorCode, reason }); changed.push(publicJob(job));
    }
    return changed;
  }

  function status(jobId) { return publicJob(exact(jobId)); }
  function snapshot() { return { version: 1, jobs: [...jobs.values()].map(publicJob), events: events.map(clone) }; }

  return { create, start, defer, rebound, settle, cancel, terminalizeForSession, terminalizeForTarget, status, snapshot };
}

module.exports = { TERMINAL_STATES, ACTIVE_STATES, createSupervisedJobCoordinator };
