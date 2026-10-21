'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGovernorJobPlan } = require('./governor-job-plan');
const { BRANCH, createEngineeringRecoveryJobPlan, psLiteral } = require('./engineering-recovery-job-plan');
const { findSpace } = require('./server-controller-filesystem');
const { middleAgentFor } = require('../dex/engineering-incident');
const roomRecoveryIntent = require('../public/room-recovery-intent');

function machineError(code, message) { return Object.assign(new Error(message), { code }); }

function createLocalPlanController({ jobs, commandStore, broker, getState, repoRoot,
  resolveHead = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() } = {}) {
  const root = path.resolve(repoRoot || path.resolve(__dirname, '..', '..', '..'));
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
    return { ...job, [kind]: extra.stored?.[kind] || plan.metadata,
      visibleTerminal: extra.stored?.visibleTerminal === true, commandAvailable: true,
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
      retrySafety: msg.retrySafety, command: msg.command, repairFiles: msg.repairFiles, preserveFiles: msg.preserveFiles,
      contextFiles: msg.contextFiles, invariants: msg.invariants, maxAttempts: msg.maxAttempts };
  }
  function prepareRecovery(msg) {
    const { room, target } = context(msg, 'MACHINE_RECOVERY_REQUEST_REQUIRED');
    const spec = recoverySpec(msg);
    const plan = createEngineeringRecoveryJobPlan({ ...spec, target }, { repoRoot });
    const worker = middleAgentFor(room);
    return store(msg, 'recovery', plan, { spec, stored: { recovery: { ...plan.metadata,
      incidentJobId: msg.incidentJobId || null, proposalMessageId: msg.proposalMessageId || null,
      worker: worker ? { memberId: worker.id, name: worker.name, providerId: worker.binding?.providerId || null } : null },
      visibleTerminal: msg.visibleTerminal === true } });
  }
  function scriptCommand(scriptPath) {
    const extension = path.extname(scriptPath).toLowerCase();
    let invoke;
    if (['.js', '.mjs', '.cjs'].includes(extension)) invoke = `& 'node' ${psLiteral(scriptPath)}`;
    else if (extension === '.py') invoke = `& 'python' '-B' ${psLiteral(scriptPath)}`;
    else if (extension === '.ps1') invoke = `& 'powershell' '-NoProfile' '-ExecutionPolicy' 'Bypass' '-File' ${psLiteral(scriptPath)}`;
    else if (['.cmd', '.bat'].includes(extension)) invoke = `& 'cmd' '/d' '/c' ${psLiteral(scriptPath)}`;
    else throw machineError('MACHINE_RECOVERY_SCRIPT_UNSUPPORTED', 'Use a .js, .mjs, .cjs, .py, .ps1, .cmd or .bat script.');
    // Windows PowerShell does not necessarily propagate a native child's nonzero
    // exit code from -EncodedCommand. Never report a failing script as GREEN.
    return `$ErrorActionPreference = 'Stop'; ${invoke}; if ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE } else { exit 1 }`;
  }
  function prepareRoomRecovery(msg) {
    if (msg.retrySafeConfirmed !== true)
      throw machineError('MACHINE_RECOVERY_IDEMPOTENCE_REQUIRED',
        'The local owner must explicitly confirm that this exact script is idempotent and safe to retry after repair.');
    const room = (getState()?.rooms || []).find((entry) => entry.id === String(msg.roomId || ''));
    const space = room && findSpace(room, String(msg.spaceId || ''));
    if (!room || !space) throw machineError('MACHINE_SPACE_REQUIRED', 'Choose the exact room and Machine Space first.');
    const worker = middleAgentFor(room);
    if (!worker || worker.binding?.providerId !== 'tlo-chat')
      throw machineError('MACHINE_RECOVERY_TLO_REQUIRED', 'Select the TLO room member as this room’s middle agent before preparing recovery.');
    const targets = (space.resourceIds || []).map((id) => broker.target(id)).filter((target) =>
      target && ['powershell', 'pwsh'].includes(target.type)
      && path.normalize(String(target.cwd || '')).toLowerCase() === path.normalize(root).toLowerCase());
    if (targets.length !== 1)
      throw machineError('MACHINE_RECOVERY_TARGET_AMBIGUOUS', 'Attach exactly one EveOS-rooted PowerShell target to this Machine Space.');
    const parsed = roomRecoveryIntent.parse(`/recover ${String(msg.scriptPath || '')}`);
    if (!parsed) throw machineError('MACHINE_RECOVERY_SCRIPT_INVALID', 'Use one repository-relative supported script path.');
    let expectedHead;
    try { expectedHead = resolveHead(root); }
    catch { throw machineError('MACHINE_RECOVERY_HEAD_UNAVAILABLE', 'Could not resolve the current EveOS Git HEAD.'); }
    const spec = { runId: String(msg.runId || ''), branch: BRANCH, expectedHead, retrySafety: 'idempotent',
      command: scriptCommand(parsed.scriptPath), repairFiles: [parsed.scriptPath], contextFiles: [parsed.scriptPath],
      invariants: [`Repair only ${parsed.scriptPath}; preserve behavior outside that script.`], maxAttempts: 1 };
    const plan = createEngineeringRecoveryJobPlan({ ...spec, target: targets[0] }, { repoRoot: root });
    return store({ ...msg, targetId: targets[0].id }, 'recovery', plan, { spec, stored: {
      recovery: { ...plan.metadata, worker: { memberId: worker.id, name: worker.name, providerId: worker.binding.providerId } },
      visibleTerminal: msg.visibleTerminal !== false, roomIssued: true
    } });
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
  return { prepareGovernor, prepareRecovery, prepareRoomRecovery, revalidate,
    currentHead: () => resolveHead(root) };
}

module.exports = { createLocalPlanController };
