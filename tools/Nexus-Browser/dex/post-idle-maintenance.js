'use strict';
// A durable, single-use out-of-band handoff to an EXACT existing local terminal.
// Does not execute shell commands or replay uncertain prompt submissions.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { dataDir, EVEOS_ROOT } = require('../runtime-config');
const { roomBusy } = require('./provider-orchestration-policy');
const { bindingMatchesSource } = require('./provider-control-receipt');

const TTL_MS = 5 * 60 * 1000, MAX_HISTORY = 32;
const DEFAULT_FILE = path.join(dataDir(), 'post-idle-maintenance.json');
const SHA_RE = /^[0-9a-f]{40}$/i, INTENT_RE = /^[A-Za-z0-9_-]{12,96}$/;
const CURRENT = new Set(['armed', 'claimed', 'submitted', 'awaiting_report']);
const REPORTABLE = new Set(['submitted', 'awaiting_report', 'outcome_unknown']);

function readJournal(file = DEFAULT_FILE, io = fs) {
  if (!io.existsSync(file)) return { version: 1, jobs: [] };
  const data = JSON.parse(io.readFileSync(file, 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.jobs)) throw new Error('POST_IDLE_JOURNAL_INVALID');
  return data;
}
function writeJournal(file, journal, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = io.openSync(temp, 'wx');
    io.writeFileSync(fd, JSON.stringify(journal), 'utf8');
    io.fsyncSync(fd); io.closeSync(fd); fd = null;
    io.renameSync(temp, file);
  } finally {
    if (fd != null) io.closeSync(fd);
    try { io.rmSync(temp, { force: true }); } catch {}
  }
}
function gitState(root = EVEOS_ROOT) {
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true
  }).trim();
  return { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
    dirty: !!git('status', '--porcelain') };
}
function readyRooms(snapshot, hasPendingControls = () => false, hasActiveTurn = () => false) {
  return !!snapshot && Array.isArray(snapshot.rooms)
    && !snapshot.rooms.some((room) => roomBusy(room) || !!room.pendingProviderControlReceipt
      || (room.members || []).some((member) => member.binding?.managedByDex === true))
    && !hasPendingControls() && !hasActiveTurn();
}
function deploymentPrompt(job) {
  return [
    '[DEX POST-IDLE MAINTENANCE HANDOFF]',
    'One server-owned out-of-band task for your EXISTING local CLI. NOT a Dex relay turn.',
    'Do not acknowledge this into Dex or generate any further notification.',
    'Job: ' + job.id,
    'Room: ' + job.roomId,
    'Expected branch: ' + job.branch,
    'Exact qualified SHA: ' + job.expectedHead,
    '',
    'The requester asserts Drift approved deployment. Verify the human authorization',
    'in the task context; stop and request it if missing. Before changes, check ALL',
    'localhost Dex rooms are idle and recovery-free. Confirm there are',
    'no pending turns or active workers. Recheck',
    'the exact Git SHA and clean working tree. Abort on any mismatch or busy room.',
    'Identify the CURRENT Nexus child and its actual supervisor; do not reuse an',
    'old PID. Restart only the verified supervised child. Observe fresh PID/session.',
    'From tools/Nexus-Browser run npm run extension:refresh. Verify this EXISTING',
    'Eve ChatGPT tab uses adapter revision ' + job.expectedAdapterRevision + ', then npm run doctor. Recheck global',
    'room idleness, pending receipts, recovery and transcript preservation.',
    'Do not change main, spawn agents, create rooms or run HEADSUP yet.',
    'Never retry an uncertain restart or reload. Report exact failure evidence.',
    '',
    'AFTER RESTART, issue exactly one authenticated local CLI report (not a relay):',
    'node scripts/dexctl.js report-post-idle ' + job.id + ' --agy-pid <YOUR_EXISTING_PID>',
    '  --result success|failed --summary "<concise exact evidence>"',
    'For success also supply --doctor-ok true --global-idle true',
    '  --adapter-revision ' + job.expectedAdapterRevision + ' --new-session <NEW_SERVER_SESSION_ID>.',
    'If dispatch outcome is uncertain, do not replay the task.',
    'This is a one-shot handoff; no acknowledgement loop.'
  ].join('\n');
}

function createPostIdleMaintenance({
  filePath = DEFAULT_FILE, io = fs, getState = () => null,
  hasPendingControls = () => false, hasActiveTurn = () => false,
  getTarget = async () => null, getTargetStatus = () => null,
  sendPrompt = async () => {}, readGit = gitState, now = Date.now,
  serverSessionId = null, onChange = () => {}
} = {}) {
  const journal = readJournal(filePath, io);
  let inFlight = false, checking = false;
  const stamp = () => new Date(now()).toISOString();
  const save = () => {
    journal.jobs = journal.jobs.slice(-MAX_HISTORY);
    writeJournal(filePath, journal, io); onChange();
  };
  let recovered = false;
  for (const job of journal.jobs) {
    if (job.state === 'claimed' || job.state === 'submitted') {
      job.state = job.deliveryAcceptedAt ? 'awaiting_report' : 'outcome_unknown';
      job.recoveredAt = stamp(); recovered = true;
    }
  }
  if (recovered) save();
  const compact = (job) => job ? ({
    id: job.id, intentId: job.intentId, roomId: job.roomId,
    authorMemberId: job.authorMemberId, targetMemberId: job.targetMemberId,
    task: job.task, expectedHead: job.expectedHead, expectedAdapterRevision: job.expectedAdapterRevision, state: job.state,
    createdAt: job.createdAt, expiresAt: job.expiresAt, claimedAt: job.claimedAt || null,
    deliveryAcceptedAt: job.deliveryAcceptedAt || null, completedAt: job.completedAt || null,
    failureCode: job.failureCode || null, summary: job.summary || null, report: job.report || null
  }) : null;
  const fail = (code, message) => ({ ok: false, code, message });
  function permitted(source, job) {
    const room = (getState()?.rooms || []).find((entry) => entry.id === job.roomId);
    return !!room && (room.members || []).some((member) =>
      (member.id === job.authorMemberId || member.id === job.targetMemberId)
      && bindingMatchesSource(member.binding, source));
  }
  function status({ source, command = {} } = {}) {
    const room = String(command.room || '');
    const jobs = journal.jobs.filter((job) => (!room || room === job.roomId) && permitted(source, job)).slice(-8).map(compact);
    return { ok: true, action: 'post_idle_status', message: jobs.length + ' authorized post-idle job(s).', data: { jobs } };
  }
  function arm({ source, command = {} } = {}) {
    const snapshot = getState();
    const room = (snapshot?.rooms || []).find((entry) => entry.id === String(command.room || ''));
    if (source?.targetClassId !== 'online-origin' || !room) return fail('POST_IDLE_ROOM_REQUIRED', 'Specify the exact room containing your browser chat.');
    const author = (room.members || []).find((member) => bindingMatchesSource(member.binding, source));
    if (!author) return fail('POST_IDLE_NOT_BOUND', 'The requesting browser chat is not bound to this room.');
    if (roomBusy(room) && !(room.relay?.active && room.relay?.waitingFor === author.id)) {
      return fail('POST_IDLE_ROOM_BUSY', 'Only the exact active source agent may arm a handoff during its own relay turn.');
    }
    if (command.task !== 'supervised-revision-deployment') return fail('POST_IDLE_BAD_TASK', 'Only bounded supervised revision deployment is supported.');
    const intentId = String(command.intentId || '');
    const expectedHead = String(command.expectedHead || '').toLowerCase();
    const branch = String(command.branch || '');
    const expectedAdapterRevision = Number(command.expectedAdapterRevision);
    if (!INTENT_RE.test(intentId) || !SHA_RE.test(expectedHead)
      || !['codex/nexus-agent-only-mode','codex/nexus-post-idle-maintenance'].includes(branch)
      || !Number.isInteger(expectedAdapterRevision) || expectedAdapterRevision < 37 || expectedAdapterRevision > 1000) {
      return fail('POST_IDLE_BAD_INTENT', 'Require a stable intentId, exact SHA and qualified development branch.');
    }
    const target = (room.members || []).find((member) => member.id === command.targetMemberId);
    if (!target || target.id === author.id || target.binding?.targetClassId !== 'local-origin'
      || target.binding?.providerId !== 'local-antigravity-existing'
      || !/^local:antigravity-existing:\d+$/.test(String(target.binding?.targetId || ''))) {
      return fail('POST_IDLE_BAD_TARGET', 'Select the exact existing Antigravity Local-Origin member ID.');
    }
    const prior = journal.jobs.find((job) => job.intentId === intentId && job.authorMemberId === author.id && job.roomId === room.id);
    if (prior) return { ok: true, action: 'arm_post_idle', message: 'Original one-shot intent returned without duplicate.', data: { job: compact(prior), deduplicated: true } };
    if (journal.jobs.some((job) => CURRENT.has(job.state))) return fail('POST_IDLE_EXCLUSIVE', 'Another post-idle task is already active.');
    if (journal.jobs.some((job) => job.roomId === room.id && job.expectedHead === expectedHead && job.targetMemberId === target.id
      && now() - Date.parse(job.createdAt) < 30 * 60 * 1000)) {
      return fail('POST_IDLE_RECENT_DUPLICATE', 'This exact handoff was requested recently; inspect its receipt.');
    }
    const job = {
      id: 'post-idle-' + randomUUID(), intentId, roomId: room.id,
      authorMemberId: author.id, targetMemberId: target.id,
      targetId: target.binding.targetId, providerId: target.binding.providerId,
      task: command.task, expectedHead, expectedAdapterRevision, branch, state: 'armed',
      createdAt: stamp(), expiresAt: new Date(now() + TTL_MS).toISOString(),
      armedServerSessionId: serverSessionId
    };
    journal.jobs.push(job); save();
    return { ok: true, action: 'arm_post_idle', message: 'Durable one-shot task armed; dispatch waits for global idle.', data: { job: compact(job) } };
  }
  function cancel({ source, command = {} } = {}) {
    const job = journal.jobs.find((item) => item.id === command.jobId && permitted(source, item));
    if (!job) return fail('POST_IDLE_NOT_FOUND', 'No authorized job matches.');
    if (job.state !== 'armed') return fail('POST_IDLE_ALREADY_CLAIMED', 'Dispatched or uncertain jobs cannot be cancelled or retried automatically.');
    job.state = 'cancelled'; job.completedAt = stamp(); save();
    return { ok: true, action: 'cancel_post_idle', message: 'Undispatched task cancelled.', data: { job: compact(job) } };
  }
  function report({ source, command = {} } = {}) {
    const job = journal.jobs.find((item) => item.id === command.jobId && permitted(source, item));
    if (!job || source?.targetClassId !== 'local-origin'
      || String(source.targetId) !== String(job.targetId) || source.providerId !== job.providerId) {
      return fail('POST_IDLE_REPORT_UNAUTHORIZED', 'Only the original exact local target may report.');
    }
    if (job.report) return { ok: true, action: 'report_post_idle', message: 'Original report retained; no duplicate.', data: { job: compact(job), deduplicated: true } };
    if (!REPORTABLE.has(job.state)) return fail('POST_IDLE_NOT_DISPATCHED', 'Job has no known or uncertain dispatch to report.');
    if (!['success', 'failed'].includes(command.result)) return fail('POST_IDLE_BAD_REPORT', 'Result must be success or failed.');
    const summary = String(command.summary || '').trim().slice(0, 480);
    if (!summary) return fail('POST_IDLE_BAD_REPORT', 'Provide concise evidence.');
    if (command.result === 'success' && (command.doctorOk !== true || command.globalIdle !== true
      || Number(command.adapterRevision) !== job.expectedAdapterRevision || !String(command.newSession || '').trim()
      || String(command.newSession) === String(job.armedServerSessionId))) {
      return fail('POST_IDLE_INCOMPLETE_EVIDENCE', 'Success requires doctor OK, global idle, exact requested adapter revision and a NEW server session ID.');
    }
    job.state = command.result === 'success' ? 'reported_success' : 'reported_failure';
    job.report = { result: command.result, summary, doctorOk: command.doctorOk === true,
      globalIdle: command.globalIdle === true, adapterRevision: Number(command.adapterRevision) || null,
      newSession: String(command.newSession || '').slice(0, 96),
      reportedBy: job.targetMemberId, evidenceType: 'local-agent-reported' };
    job.completedAt = stamp(); save();
    return { ok: true, action: 'report_post_idle', message: 'Durable local-origin receipt recorded without a new relay turn.', data: { job: compact(job) } };
  }
  const leaseActive = () => inFlight || checking;
  function close(job, state, code, summary) {
    if (!job || !['armed', 'claimed', 'submitted', 'awaiting_report'].includes(job.state)) return;
    job.state = state; job.failureCode = code || null; job.summary = String(summary || '').slice(0, 480);
    job.completedAt = stamp(); save();
  }
  async function tick() {
    if (checking || inFlight) return false;
    checking = true;
    try {
    const job = journal.jobs.find((entry) => entry.state === 'armed');
    if (!job) return false;
    if (now() >= Date.parse(job.expiresAt)) { close(job, 'expired', 'POST_IDLE_EXPIRED', 'No dispatch before expiry.'); return false; }
    const snapshot = getState();
    if (!readyRooms(snapshot, hasPendingControls, hasActiveTurn)) return false;
    let git;
    try { git = await readGit(); } catch (error) {
      close(job, 'blocked', 'POST_IDLE_GIT_UNAVAILABLE', error.message); return false;
    }
    if (String(git.head).toLowerCase() !== job.expectedHead || git.branch !== job.branch || git.dirty) {
      close(job, 'blocked', 'POST_IDLE_GIT_MISMATCH', 'Exact SHA, branch or clean-tree gate failed.'); return false;
    }
    const member = (snapshot.rooms.find((room) => room.id === job.roomId)?.members || [])
      .find((candidate) => candidate.id === job.targetMemberId);
    if (member?.binding?.targetId !== job.targetId || member.binding?.providerId !== job.providerId) {
      close(job, 'blocked', 'POST_IDLE_TARGET_REBOUND', 'Original Local-Origin identity changed.'); return false;
    }
    let target;
    try { target = await getTarget(job.targetId); } catch { return false; }
    if (!target || target.id !== job.targetId || target.providerId !== job.providerId || target.sessionOrigin !== 'existing') return false;
    const targetStatus = getTargetStatus(job.targetId);
    if (targetStatus?.busy || targetStatus?.running === false) return false;
    if (!readyRooms(getState(), hasPendingControls, hasActiveTurn)) return false;
    inFlight = true; job.claimedAt = stamp(); job.state = 'claimed'; save();
    let dispatched = false;
    try {
      await sendPrompt({
        targetId: job.targetId, requestId: job.id, text: deploymentPrompt(job),
        emit(event) {
          if (event?.type === 'prompt_dispatched' && !dispatched) {
            dispatched = true; job.deliveryAcceptedAt = stamp(); job.state = 'submitted'; save();
          }
          if (event?.type === 'error') job.summary = String(event.message || event.code || 'Local target error').slice(0, 480);
        }
      });
      if (job.state === 'submitted') { job.state = 'awaiting_report'; save(); }
      else if (job.state === 'claimed') close(job, 'outcome_unknown', 'POST_IDLE_DELIVERY_UNCONFIRMED', 'No confirmed prompt submission.');
    } catch (error) {
      if (dispatched) { job.state = 'awaiting_report'; job.summary = String(error.message || error).slice(0, 480); save(); }
      else close(job, 'outcome_unknown', 'POST_IDLE_DELIVERY_UNCERTAIN', error.message);
    } finally { inFlight = false; }
    return dispatched;
    } finally { checking = false; }
  }
  return { arm, status, cancel, report, tick, leaseActive,
    readyRooms: () => readyRooms(getState(), hasPendingControls, hasActiveTurn),
    diagnostics: () => ({ inFlight, active: compact(journal.jobs.find((job) => CURRENT.has(job.state)) || null),
      last: compact(journal.jobs.at(-1) || null) }) };
}
module.exports = { TTL_MS, DEFAULT_FILE, readJournal, writeJournal, gitState, readyRooms,
  deploymentPrompt, createPostIdleMaintenance };
