'use strict';

const { createGovernorJobPlan } = require('./governor-job-plan');
const { createEngineeringRecoveryJobPlan } = require('./engineering-recovery-job-plan');
const { findSpace } = require('./server-controller-filesystem');

function machineError(code, message) { return Object.assign(new Error(message), { code }); }

function createLocalPlanController({ jobs, commandStore, broker, getState, repoRoot } = {}) {
  function context(msg, requestCode) {
    const room = (getState()?.rooms || []).find((entry) => entry.id === String(msg.roomId || ''));
    if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Choose the exact active Dex room.');
    const space = findSpace(room, String(msg.spaceId || ''));
    if (!space) throw machineError('MACHINE_SPACE_REQUIRED', 'Choose an exact active Machine Space.');
    const targetId = String(msg.targetId || '');
    const target = broker.target(targetId);
    if (!target || !(space.resourceIds || []).includes(targetId))
      throw machineError('MACHINE_TARGET_NOT_ATTACHED', 'Attach the managed PowerShell target to this exact Machine Space first.');
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(String(msg.requestId || '')))
      throw machineError(requestCode, 'A stable bounded requestId is required.');
    return { room, space, targetId, target };
  }
  function store(msg, kind, plan, extra = {}) {
    const { room, space, targetId, target } = context(msg, `MACHINE_${kind.toUpperCase()}_REQUEST_REQUIRED`);
    const job = jobs.create({ requestId: msg.requestId, kind, roomId: room.id, spaceId: space.id,
      ownerMemberId: 'local', targetId, processEpoch: target.processEpoch, commandDigest: plan.commandDigest });
    const prior = commandStore.get(job.jobId);
    if (job.kind !== kind || (prior && (prior.kind !== kind || prior.commandDigest !== plan.commandDigest)))
      throw machineError('MACHINE_JOB_REQUEST_CONFLICT', 'Request ID already owns another immutable job.');
    if (!prior && job.state !== 'queued')
      throw machineError('MACHINE_JOB_NO_REPLAY', 'A started or settled supervised plan cannot be prepared again.');
    if (!prior) commandStore.set(job.jobId, { command: plan.command, commandDigest: plan.commandDigest,
      displayCommand: plan.originalCommand || null, kind, spec: extra.spec, ...extra.stored });
    return { ...job, [kind]: plan.metadata, commandAvailable: true,
      commandPreview: plan.originalCommand || null };
  }
  function prepareGovernor(msg) {
    const { target } = context(msg, 'MACHINE_GOVERNOR_REQUEST_REQUIRED');
    const spec = { runId: msg.runId, expectedHead: msg.expectedHead, tier: msg.tier,
      mission: msg.mission, allowedFiles: msg.allowedFiles };
    const plan = createGovernorJobPlan({ ...spec, target }, { repoRoot });
    return store(msg, 'governor', plan, { spec,
      stored: { missionSha256: plan.missionSha256, governor: plan.metadata } });
  }
  function recoverySpec(msg) {
    return { runId: msg.runId, branch: msg.branch, expectedHead: msg.expectedHead,
      retrySafety: msg.retrySafety, command: msg.command, repairFiles: msg.repairFiles,
      contextFiles: msg.contextFiles, invariants: msg.invariants, maxAttempts: msg.maxAttempts };
  }
  function prepareRecovery(msg) {
    const { target } = context(msg, 'MACHINE_RECOVERY_REQUEST_REQUIRED');
    const spec = recoverySpec(msg);
    const plan = createEngineeringRecoveryJobPlan({ ...spec, target }, { repoRoot });
    return store(msg, 'recovery', plan, { spec, stored: { recovery: plan.metadata } });
  }
  function revalidate(stored, target) {
    let current;
    try {
      current = stored.kind === 'governor'
        ? createGovernorJobPlan({ ...stored.spec, target }, { repoRoot })
        : stored.kind === 'recovery'
          ? createEngineeringRecoveryJobPlan({ ...stored.spec, target }, { repoRoot }) : null;
    } catch {
      throw machineError(`MACHINE_${String(stored.kind || 'JOB').toUpperCase()}_PLAN_CHANGED`,
        'The supervised authority plan is no longer valid; do not start it.');
    }
    if (current && current.commandDigest !== stored.commandDigest)
      throw machineError(`MACHINE_${stored.kind.toUpperCase()}_PLAN_CHANGED`,
        'The supervised authority plan changed after preparation; do not start it.');
    if (stored.kind === 'governor' && current.missionSha256 !== stored.missionSha256)
      throw machineError('MACHINE_GOVERNOR_PLAN_CHANGED', 'Governor mission changed after preparation; do not start it.');
    return current;
  }
  return { prepareGovernor, prepareRecovery, revalidate };
}

module.exports = { createLocalPlanController };
