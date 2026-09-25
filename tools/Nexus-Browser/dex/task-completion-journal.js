'use strict';
// Durable result ownership. No task is launched, restarted or replayed by this journal.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { dataDir } = require('../runtime-config');
const { gitState, readJournal, writeJournal } = require('./post-idle-maintenance');
const { bindingMatchesSource, compactBinding } = require('./provider-control-receipt');

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_JOBS = 128, REPORT_MAX_BYTES = 32768;
const JOB_ID = /^task-completion-[0-9a-f-]{36}$/i;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,95}$/;
const SHA = /^[0-9a-f]{40}$/i;
const DEFAULT_FILE = path.join(dataDir(), 'task-completion-journal.json');
const hash = (token) => createHash('sha256').update(String(token)).digest('hex');
function tokenMatches(token, digest) {
  if (!/^[0-9a-f]{64}$/i.test(String(digest)) || !/^[0-9a-f]{64}$/i.test(String(token))) return false;
  return timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(digest, 'hex'));
}
function resultPath(root, id) {
  if (!JOB_ID.test(id)) throw new Error('TASK_COMPLETION_BAD_JOB_ID');
  return path.join(root, 'task-completions', 'reports', id + '.json');
}
function credentialPath(root, id) {
  if (!JOB_ID.test(id)) throw new Error('TASK_COMPLETION_BAD_JOB_ID');
  return path.join(root, 'task-completions', 'credentials', id + '.json');
}
function compact(job) {
  if (!job) return null;
  const { id, taskId, roomId, workerMemberId, requesterMemberId, branch, expectedHead,
    registeredAt, expiresAt, state, report, claimedAt, deliveredAt, deliveryError } = job;
  return { id, taskId, roomId, workerMemberId, requesterMemberId, branch, expectedHead,
    registeredAt, expiresAt, state, report: report || null, claimedAt: claimedAt || null,
    deliveredAt: deliveredAt || null, deliveryError: deliveryError || null };
}
function createTaskCompletionJournal({
  root = dataDir(), filePath = path.join(root, 'task-completion-journal.json'),
  io = fs, getState = () => null, readGit = gitState, validateLocal = async () => false,
  now = Date.now
} = {}) {
  const journal = readJournal(filePath, io);
  let recovered = false;
  for (const job of journal.jobs) {
    if (job.state !== 'sent-unconfirmed') continue;
    job.state = 'outcome-unknown';
    job.deliveryError = 'Server restarted after submission claim; do not automatically resend.';
    recovered = true;
  }
  const stamp = () => new Date(now()).toISOString();
  const save = () => writeJournal(filePath, journal, io);
  if (recovered) save();
  const error = (code, message) => ({ ok: false, code, message });
  function roomFor(job) { return (getState()?.rooms || []).find((room) => room.id === job.roomId); }
  function validWorker(job, source) {
    const room = roomFor(job);
    const worker = (room?.members || []).find((m) => m.id === job.workerMemberId);
    return !!worker && bindingMatchesSource(worker.binding, source)
      && String(worker.binding?.targetId) === String(job.workerTargetId)
      && worker.binding?.providerId === job.workerProviderId;
  }
  async function register({ source = {}, command = {} } = {}) {
    if (source.targetClassId !== 'local-origin' || !(await validateLocal(source))) {
      return error('TASK_COMPLETION_BAD_SOURCE', 'Registration requires the exact live Local-Origin agent.');
    }
    const snapshot = getState();
    const room = (snapshot?.rooms || []).find((entry) => entry.id === command.roomId);
    const worker = (room?.members || []).find((m) => bindingMatchesSource(m.binding, source));
    const requester = (room?.members || []).find((m) => m.id === command.requesterMemberId);
    if (!room || !worker || !requester || worker.id === requester.id
      || requester.binding?.targetClassId !== 'online-origin'
      || !requester.binding?.url || requester.binding?.targetId == null) {
      return error('TASK_COMPLETION_BAD_ROOM', 'Require one exact room, existing local worker and online requester.');
    }
    const taskId = String(command.taskId || '');
    const expectedHead = String(command.expectedHead || '').toLowerCase();
    const branch = String(command.branch || '');
    if (!TASK_ID.test(taskId) || !SHA.test(expectedHead)
      || !/^[A-Za-z0-9_.\/-]{1,128}$/.test(branch) || branch.includes('..')) {
      return error('TASK_COMPLETION_BAD_INTENT', 'Require task ID, exact 40-character SHA and explicit branch.');
    }
    const previous = journal.jobs.find((job) => job.taskId === taskId);
    if (previous) {
      if (previous.roomId !== room.id || previous.workerMemberId !== worker.id
        || previous.requesterMemberId !== requester.id || previous.expectedHead !== expectedHead
        || previous.branch !== branch || !validWorker(previous, source)) {
        return error('TASK_COMPLETION_ID_CONFLICT', 'This task ID already belongs to another immutable request.');
      }
      if (!io.existsSync(credentialPath(root, previous.id))) {
        return error('TASK_COMPLETION_CREDENTIAL_MISSING', 'Original registration exists but its local credential is missing.');
      }
      return { ok: true, deduplicated: true, job: compact(previous) };
    }
    // Fail closed on registration against unqualified or dirty local source.
    let git;
    try { git = await readGit(); }
    catch (e) { return error('TASK_COMPLETION_GIT_UNAVAILABLE', String(e.message).slice(0, 160)); }
    if (String(git.head).toLowerCase() !== expectedHead || git.branch !== branch || git.dirty) {
      return error('TASK_COMPLETION_GIT_MISMATCH', 'The exact branch/SHA or clean-tree gate failed.');
    }
    if (journal.jobs.length >= MAX_JOBS) {
      return error('TASK_COMPLETION_LIMIT', 'Full journal: reconcile older entries explicitly before registering more tasks.');
    }
    const id = 'task-completion-' + randomUUID(), token = randomBytes(32).toString('hex');
    const job = {
      id, taskId, roomId: room.id, roomName: room.name || room.id,
      workerMemberId: worker.id, workerTargetId: String(worker.binding.targetId),
      workerProviderId: worker.binding.providerId,
      requesterMemberId: requester.id, requesterTarget: compactBinding(requester.binding),
      expectedHead, branch, tokenDigest: hash(token), registeredAt: stamp(),
      expiresAt: new Date(now() + TTL_MS).toISOString(), state: 'armed'
    };
    // Credential is an existing-local-runner capability, not part of room state,
    // browser notification text or the status API.
    const credential = { version: 1, id, taskId, expectedHead, branch, token };
    writeJournal(credentialPath(root, id), credential, io);
    journal.jobs.push(job);
    try { save(); } catch (e) { journal.jobs.pop(); throw e; }
    return { ok: true, job: compact(job) };
  }
  async function status({ source = {}, command = {} } = {}) {
    if (source.targetClassId !== 'local-origin' || !(await validateLocal(source))) {
      return error('TASK_COMPLETION_BAD_SOURCE', 'Status requires an existing local target.');
    }
    const roomId = String(command.roomId || '');
    const jobs = journal.jobs.filter((job) => (!roomId || job.roomId === roomId) && validWorker(job, source));
    return { ok: true, jobs: jobs.slice(-16).map(compact) };
  }
  function acceptedLogs(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 8).map((v) => String(v || '').slice(0, 240)).filter((v) =>
      v.startsWith('task-completions/logs/') && !v.includes('..')
      && /^[A-Za-z0-9_./-]+$/.test(v));
  }
  function finish(job, report) {
    job.report = report; job.state = 'ready'; job.readyAt = stamp(); save();
    try { io.rmSync(resultPath(root, job.id), { force: true }); } catch {}
  }
  function scan() {
    let changed = 0;
    for (const job of journal.jobs) {
      if (job.state !== 'armed') continue;
      const file = resultPath(root, job.id);
      if (io.existsSync(file)) {
        let payload;
        try {
          if (io.statSync(file).size > REPORT_MAX_BYTES) throw new Error('Oversized task result');
          payload = JSON.parse(io.readFileSync(file, 'utf8'));
        } catch { continue; } // Do not treat transient or unreadable files as success.
        if (payload?.version !== 1 || payload.id !== job.id
          || payload.taskId !== job.taskId || String(payload.expectedHead).toLowerCase() !== job.expectedHead
          || !tokenMatches(payload.token, job.tokenDigest)
          || !['success', 'failed'].includes(payload.result)
          || typeof payload.summary !== 'string' || !payload.summary.trim()) {
          finish(job, { result: 'unknown', code: 'TASK_COMPLETION_INVALID_REPORT',
            summary: 'Result manifest failed immutable identity/token validation; manual review required.',
            stageResults: [], logs: [] });
          changed++; continue;
        }
        const stages = Array.isArray(payload.stageResults) ? payload.stageResults : [];
        finish(job, {
          result: payload.result, summary: payload.summary.trim().slice(0, 1000),
          stageResults: stages.slice(0, 8).map((stage) => ({
            name: String(stage?.name || '').slice(0, 48),
            exitCode: Number.isInteger(stage?.exitCode) ? stage.exitCode : null
          })), logs: acceptedLogs(payload.logs)
        });
        changed++; continue;
      }
      if (now() >= Date.parse(job.expiresAt)) {
        finish(job, { result: 'unknown', code: 'TASK_COMPLETION_EXPIRED',
          summary: 'No signed task report arrived before the 12-hour deadline. Actual execution outcome is unknown; do not rerun automatically.',
          stageResults: [], logs: [] });
        changed++;
      }
    }
    return changed;
  }
  function claim(id) {
    const job = journal.jobs.find((entry) => entry.id === id);
    if (!job || job.state !== 'ready') return null;
    job.state = 'sent-unconfirmed'; job.claimedAt = stamp(); save();
    return compact(job);
  }
  function ack(id, accepted, message = '') {
    const job = journal.jobs.find((entry) => entry.id === id);
    if (!job || job.state !== 'sent-unconfirmed') return null;
    job.state = accepted ? 'confirmed' : 'submission-failed';
    job.deliveredAt = stamp();
    if (!accepted) job.deliveryError = String(message || 'Provider did not accept notification').slice(0, 160);
    save(); return compact(job);
  }
  function uncertain(id, message) {
    const job = journal.jobs.find((entry) => entry.id === id);
    if (!job || job.state !== 'sent-unconfirmed') return null;
    job.state = 'outcome-unknown';
    job.deliveryError = String(message || 'Submission outcome unknown. No automatic replay.').slice(0, 160);
    save(); return compact(job);
  }
  const deliveryView = (job) => ({ ...compact(job), requesterTarget: job.requesterTarget,
    workerTargetId: job.workerTargetId, workerProviderId: job.workerProviderId });
  const ready = () => journal.jobs.filter((job) => job.state === 'ready').map(deliveryView);
  const all = () => journal.jobs.map(compact);
  const diagnostics = () => {
    const states = {};
    for (const job of journal.jobs) states[job.state] = (states[job.state] || 0) + 1;
    return { total: journal.jobs.length, states, latest: compact(journal.jobs.at(-1)) };
  };
  return { register, status, scan, claim, ack, uncertain, ready, all, diagnostics,
    root, filePath, resultPath: (id) => resultPath(root, id) };
}
module.exports = { TTL_MS, MAX_JOBS, REPORT_MAX_BYTES, DEFAULT_FILE, JOB_ID, TASK_ID,
  resultPath, credentialPath, tokenMatches, createTaskCompletionJournal };
