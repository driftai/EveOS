'use strict';

const { createHash } = require('node:crypto');
const { commandDigest } = require('./approval-broker');

const SCHEMA = 'eveos.machine-spaces.engineering-workflow-authorization.v1';
const TTL_MS = 30 * 60 * 1000;

function text(value) { return String(value ?? '').trim(); }
function fault(code, message) { return Object.assign(new Error(message), { code }); }
function sameList(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}
function scopeDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function workflowEligible(job, stored) {
  const recovery = job?.kind === 'terminal-supervised'
    && stored?.retrySafety === 'idempotent'
    && Array.isArray(stored.repairFiles)
    && stored.repairFiles.length > 0;
  const governedPublication = job?.kind === 'governor'
    && stored?.governor?.publication?.branch === 'eve/nexus-machine-spaces'
    && Array.isArray(stored.governor.allowedFiles)
    && stored.governor.allowedFiles.length > 0;
  return recovery || governedPublication;
}

function createWorkflowAuthorization({ job, stored, expectedHead, now = Date.now } = {}) {
  if (!workflowEligible(job, stored))
    throw fault('MACHINE_WORKFLOW_NOT_ELIGIBLE', 'Only an idempotent supervised engineering job with exact repair files can receive workflow approval.');
  if (!/^[a-f0-9]{40}$/.test(text(expectedHead)))
    throw fault('MACHINE_WORKFLOW_HEAD_REQUIRED', 'Workflow approval requires the exact current Git HEAD.');
  const governed = job.kind === 'governor';
  const scope = {
    schema: SCHEMA,
    rootJobId: job.jobId,
    roomId: job.roomId,
    spaceId: job.spaceId,
    targetId: job.targetId,
    processEpoch: job.processEpoch,
    commandDigest: job.commandDigest,
    expectedHead: text(expectedHead),
    repairFiles: governed ? [...stored.governor.allowedFiles] : [...stored.repairFiles],
    contextFiles: governed ? [...stored.governor.allowedFiles] : [...(stored.contextFiles || stored.repairFiles)],
    invariants: governed ? ['Qualify the exact authorized file set before guarded publication.'] : [...(stored.invariants || [])],
    maxRecoveryJobs: governed ? 0 : 1,
    ...(governed ? { governedPublication: {
      runId: stored.governor.runId,
      missionSha256: stored.missionSha256,
      preserveFiles: [...(stored.governor.preserveFiles || [])],
      publication: { ...stored.governor.publication }
    } } : {}),
    expiresAt: new Date(now() + TTL_MS).toISOString()
  };
  return Object.freeze({ ...scope, scopeDigest: scopeDigest(scope) });
}

function validateInheritedRecovery({ authorization, incidentJob, recoveryJob, stored,
  currentHead, now = Date.now } = {}) {
  if (!authorization || authorization.schema !== SCHEMA)
    throw fault('MACHINE_WORKFLOW_AUTHORIZATION_MISSING', 'The failed job has no exact workflow authorization.');
  if (authorization.maxRecoveryJobs !== 1 || authorization.governedPublication)
    throw fault('MACHINE_WORKFLOW_RECOVERY_NOT_AUTHORIZED', 'This workflow approval does not include an engineering recovery job.');
  if (Date.parse(authorization.expiresAt) <= now())
    throw fault('MACHINE_WORKFLOW_AUTHORIZATION_EXPIRED', 'The one-time workflow approval expired before recovery.');
  if (!incidentJob || incidentJob.jobId !== authorization.rootJobId || incidentJob.state !== 'failed')
    throw fault('MACHINE_WORKFLOW_INCIDENT_MISMATCH', 'Recovery is not bound to the authorized failed job.');
  if (text(currentHead) !== authorization.expectedHead)
    throw fault('MACHINE_WORKFLOW_HEAD_CHANGED', 'Repository HEAD changed after workflow approval; fresh owner approval is required.');
  const sameTarget = recoveryJob?.kind === 'recovery'
    && recoveryJob.roomId === authorization.roomId
    && recoveryJob.spaceId === authorization.spaceId
    && recoveryJob.targetId === authorization.targetId
    && recoveryJob.processEpoch === authorization.processEpoch;
  if (!sameTarget)
    throw fault('MACHINE_WORKFLOW_TARGET_CHANGED', 'Recovery room, Machine Space, terminal, or process epoch changed.');
  const recovery = stored?.recovery;
  if (stored?.kind !== 'recovery' || recovery?.incidentJobId !== authorization.rootJobId
      || recovery?.expectedHead !== authorization.expectedHead || recovery?.retrySafety !== 'idempotent'
      || recovery?.maxAttempts !== 1)
    throw fault('MACHINE_WORKFLOW_PLAN_CHANGED', 'The prepared recovery no longer matches the one-time workflow grant.');
  if (!Array.isArray(recovery.repairFiles) || !recovery.repairFiles.length
      || recovery.repairFiles.some((file) => !authorization.repairFiles.includes(file))
      || !sameList(recovery.contextFiles, authorization.contextFiles)
      || !sameList(recovery.invariants, authorization.invariants)
      || commandDigest(stored.displayCommand || '') !== authorization.commandDigest)
    throw fault('MACHINE_WORKFLOW_SCOPE_CHANGED', 'Recovery command or file authority widened after owner approval.');
  const comparable = { ...authorization };
  delete comparable.scopeDigest;
  if (scopeDigest(comparable) !== authorization.scopeDigest)
    throw fault('MACHINE_WORKFLOW_AUTHORIZATION_TAMPERED', 'Workflow authorization scope digest no longer matches.');
  return {
    method: 'inherited-owner-workflow',
    sourceMessageId: incidentJob.authorization?.sourceMessageId || null,
    approvalDigest: authorization.scopeDigest,
    workflow: authorization
  };
}

module.exports = { SCHEMA, TTL_MS, workflowEligible, createWorkflowAuthorization, validateInheritedRecovery };
