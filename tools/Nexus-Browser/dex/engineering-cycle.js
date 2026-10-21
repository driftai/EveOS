'use strict';

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const stateApi = require('./server-scheduler-state');

const MAX_RECEIPTS = 128;
function token(value) { return String(value || '').trim(); }
function requestId(messageId) {
  const digest = createHash('sha256').update(token(messageId)).digest('hex').slice(0, 20);
  return `engineering-recovery:${digest}`;
}

function createEngineeringCycle({ load, save, broadcastState = () => {}, machineSpaces,
  incidentBridge, repoRoot, resolveHead = (root) => execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', windowsHide: true
  }).trim(), now = () => new Date().toISOString() } = {}) {
  if (typeof load !== 'function' || typeof save !== 'function' || !machineSpaces?.prepareEngineeringRecovery
      || !incidentBridge?.handle) throw new TypeError('engineering cycle requires state, Machine Spaces and incident owners');
  const failures = new Map();

  function onJobSettled(job, stored = null) {
    if (job?.state === 'failed' && job.kind !== 'recovery' && stored?.retrySafety === 'idempotent'
        && Array.isArray(stored.repairFiles) && stored.repairFiles.length) {
      failures.set(job.jobId, { job: structuredClone(job), command: stored.command,
        repairFiles: [...stored.repairFiles], contextFiles: [...(stored.contextFiles || stored.repairFiles)],
        invariants: [...(stored.invariants || [])], workflowAuthorization: job.authorization?.workflow || null });
    }
    return incidentBridge.handle({ ...job, engineeringPlan: failures.get(job?.jobId) || null });
  }

  function reconcile() {
    let snapshot = load(), changed = false;
    for (const room of snapshot?.rooms || []) {
      room.engineeringCycleReceipts = Array.isArray(room.engineeringCycleReceipts)
        ? room.engineeringCycleReceipts : [];
      for (const message of room.messages || []) {
        const proposal = message.engineeringProposal;
        if (!proposal?.ok || room.engineeringCycleReceipts.some((entry) => entry.proposalMessageId === message.id)) continue;
        const context = failures.get(proposal.incidentJobId);
        const receipt = { proposalMessageId: message.id, incidentJobId: proposal.incidentJobId,
          createdAt: now(), state: 'safe-stopped', recoveryJobId: null, code: null };
        try {
          if (!context) throw Object.assign(new Error('Original failed command authority is unavailable.'), { code: 'ENGINEERING_CONTEXT_UNAVAILABLE' });
          if (proposal.retryIntent !== 'after-verified-repair' || proposal.repair?.kind !== 'source-patch')
            throw Object.assign(new Error('Proposal did not request a verified source repair.'), { code: 'ENGINEERING_REPAIR_NOT_REQUESTED' });
          const paths = proposal.repair.paths || [];
          if (!paths.length || paths.some((item) => !context.repairFiles.includes(item)))
            throw Object.assign(new Error('Proposal paths exceed the original repair candidates.'), { code: 'ENGINEERING_REPAIR_SCOPE_MISMATCH' });
          const expectedHead = resolveHead(repoRoot);
          const job = machineSpaces.prepareEngineeringRecovery({
            requestId: requestId(message.id), roomId: context.job.roomId, spaceId: context.job.spaceId,
            targetId: context.job.targetId, runId: `incident-${proposal.incidentJobId.slice(-20)}`,
            branch: 'eve/nexus-machine-spaces', expectedHead, retrySafety: 'idempotent',
            command: context.command, repairFiles: paths, contextFiles: context.contextFiles,
            invariants: context.invariants, maxAttempts: 1, visibleTerminal: true,
            incidentJobId: proposal.incidentJobId, proposalMessageId: message.id
          });
          receipt.state = 'approval-pending'; receipt.recoveryJobId = job.jobId; receipt.code = 'ENGINEERING_RECOVERY_PREPARED';
          if (context.workflowAuthorization && typeof machineSpaces.startEngineeringRecovery === 'function') {
            machineSpaces.startEngineeringRecovery(job.jobId, { authorization: context.workflowAuthorization,
              incidentJob: context.job });
            receipt.state = 'running'; receipt.code = 'ENGINEERING_WORKFLOW_RECOVERY_STARTED';
          }
          const system = stateApi.addMessage(room, { senderKind: 'system', senderId: null,
            senderName: 'Machine Spaces', text: `[ENGINEERING RECOVERY PREPARED]\nincident=${proposal.incidentJobId}\nproposal=${message.id}\nrecoveryJob=${job.jobId}\n${receipt.state === 'running'
              ? 'The exact repair started under the original bounded owner workflow approval.'
              : 'The exact repair remains inert until independent local-owner approval.'}` });
          system.engineeringRecoveryPrepared = { incidentJobId: proposal.incidentJobId,
            proposalMessageId: message.id, recoveryJobId: job.jobId };
        } catch (error) {
          receipt.code = error.code || 'ENGINEERING_RECOVERY_PREPARE_FAILED';
          receipt.message = String(error.message || error).slice(0, 240);
        }
        room.engineeringCycleReceipts.push(receipt);
        room.engineeringCycleReceipts = room.engineeringCycleReceipts.slice(-MAX_RECEIPTS);
        changed = true;
      }
    }
    if (changed) { snapshot = save(snapshot); broadcastState(snapshot); }
    return { ok: true, changed };
  }
  return { onJobSettled, reconcile };
}

module.exports = { createEngineeringCycle, requestId };
