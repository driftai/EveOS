'use strict';

const { randomUUID } = require('node:crypto');
const stateApi = require('./server-scheduler-state');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'outcome-unknown']);
const MAX_RECEIPTS = 128;

function bounded(value, limit = 160) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, limit);
}

function failureClass(job = {}) {
  const code = bounded(job.errorCode, 96).toUpperCase();
  const reason = bounded(job.reason, 240).toLowerCase();
  if (job.state === 'outcome-unknown') return 'execution-outcome-unknown';
  if (/TARGET|EPOCH|SESSION|STALE/.test(code)) return 'stale-terminal-or-target-epoch';
  if (/TIMEOUT/.test(code) || /timed? out/.test(reason)) return 'timeout-or-crash';
  if (/PERMISSION|AUTH|APPROVAL|GRANT/.test(code)) return 'authorization-required';
  if (/NOT_FOUND|DEPENDENCY|ENOENT/.test(code)) return 'dependency-unavailable';
  if (/UNAVAILABLE|DISCONNECT|TRANSPORT/.test(code)) return 'service-or-transport-unavailable';
  if (job.state === 'failed') return 'confirmed-command-or-test-failure';
  return job.state || 'unknown';
}

function enabledMembers(room) {
  return (room?.members || []).filter((member) => member?.relayEnabled !== false && member?.binding);
}

function middleAgentFor(room) {
  const settings = room?.settings || {};
  if (settings.middleAgentMode === 'disabled') return null;
  const memberId = bounded(settings.middleAgentMemberId, 128);
  if (memberId) return enabledMembers(room).find((member) => member.id === memberId) || null;
  if (settings.middleAgentMode === 'manual') return null;
  const eligible = enabledMembers(room).filter((member) => member.engineeringRole === 'middle-agent');
  if (eligible.length === 1) return eligible[0];
  const fallback = enabledMembers(room);
  return fallback.length === 1 ? fallback[0] : null;
}

function incidentText(job, classification) {
  const result = job.result || {};
  const lines = [
    '[ENGINEERING INCIDENT v1]',
    `state=${bounded(job.state, 32)} class=${classification}`,
    `job=${bounded(job.jobId, 128)} request=${bounded(job.requestId, 128)}`,
    `space=${bounded(job.spaceId || 'none', 128)} target=${bounded(job.targetId, 128)} epoch=${bounded(job.processEpoch, 128)}`,
    `exit=${result.exitCode ?? 'unknown'} error=${bounded(job.errorCode || 'none', 96)} outputReceipt=${bounded(result.outputId || 'none', 128)}`
  ];
  if (job.reason) lines.push(`reason=${bounded(job.reason, 240)}`);
  if (job.state === 'failed') lines.push(
    'Middle-agent task: reply with exactly one JSON object (no prose or fence).',
    `Required template: {"schema":"eveos.machine-spaces.engineering-proposal.v1","incidentJobId":"${bounded(job.jobId, 128)}","classification":"${classification}","summary":"bounded diagnosis","confidence":0.0,"requestedEvidence":[],"repair":{"kind":"none","paths":[],"description":"bounded recommendation"},"retryIntent":"none"}`,
    'Allowed repair.kind: none, prepare-command, source-patch, await-approval. Allowed retryIntent: none, after-verified-repair, requires-approval. Paths must be repository-relative, or [] when no source change is proposed.',
    'Diagnose from bounded evidence only. Do not claim execution, apply changes, or replay the failed command.'
  );
  else if (job.state === 'outcome-unknown') lines.push('Safe stop: execution outcome is uncertain. Do not replay or propose automatic retry.');
  return lines.join('\n');
}

function createEngineeringIncidentBridge({ load, save, scheduler, broadcastState = () => {},
  now = () => new Date().toISOString(), uid = randomUUID } = {}) {
  if (typeof load !== 'function' || typeof save !== 'function' || !scheduler?.startMemberTurn)
    throw new TypeError('engineering incident bridge requires Dex state and the existing scheduler');

  function handle(job = {}) {
    if (!job.roomId || !job.jobId || !TERMINAL.has(job.state)) return { ok: false, code: 'ENGINEERING_INCIDENT_NOT_TERMINAL' };
    let snapshot = load(), room = stateApi.roomById(snapshot, job.roomId);
    if (!room) return { ok: false, code: 'ENGINEERING_INCIDENT_ROOM_NOT_FOUND' };
    room.engineeringIncidentReceipts = Array.isArray(room.engineeringIncidentReceipts) ? room.engineeringIncidentReceipts : [];
    const key = `${job.jobId}:${job.state}:${job.finishedAt || ''}`;
    const prior = room.engineeringIncidentReceipts.find((entry) => entry.key === key);
    if (prior) return { ok: true, deduplicated: true, receipt: prior };
    const classification = failureClass(job), at = now();
    const message = stateApi.addMessage(room, { id: `msg-engineering-${uid()}`, at,
      senderKind: 'system', senderId: null, senderName: 'Machine Spaces', text: incidentText(job, classification) });
    message.engineeringIncident = { schema: 'eveos.machine-spaces.engineering-incident.v1', jobId: job.jobId,
      requestId: job.requestId || null, classification, outputId: job.result?.outputId || null };
    const receipt = { key, jobId: job.jobId, requestId: job.requestId || null, state: job.state,
      classification, messageId: message.id, createdAt: at, middleAgentMemberId: null,
      dispatch: job.state === 'failed' ? 'pending' : 'not-required' };
    room.engineeringIncidentReceipts.push(receipt);
    room.engineeringIncidentReceipts = room.engineeringIncidentReceipts.slice(-MAX_RECEIPTS);
    snapshot = save(snapshot); broadcastState(snapshot);
    if (job.state !== 'failed') return { ok: true, receipt };

    room = stateApi.roomById(snapshot, job.roomId);
    const middle = middleAgentFor(room);
    let dispatch = middle
      ? scheduler.startMemberTurn({ roomId: room.id, sourceMessageId: message.id, memberId: middle.id, purpose: 'engineering-recovery' })
      : { ok: false, code: 'ENGINEERING_MIDDLE_AGENT_UNAVAILABLE', message: 'No eligible middle agent is selected.' };
    snapshot = load(); room = stateApi.roomById(snapshot, job.roomId);
    const stored = (room?.engineeringIncidentReceipts || []).find((entry) => entry.key === key);
    if (stored) {
      stored.middleAgentMemberId = middle?.id || null;
      stored.dispatch = dispatch.ok ? 'scheduled' : 'safe-stopped';
      stored.dispatchCode = dispatch.code || null;
      snapshot = save(snapshot); broadcastState(snapshot);
    }
    return { ok: true, receipt: stored || receipt, dispatch };
  }
  return { handle, middleAgentFor, failureClass };
}

module.exports = { TERMINAL, failureClass, middleAgentFor, incidentText, createEngineeringIncidentBridge };
