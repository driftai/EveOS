'use strict';

// Local-owner-only projection of the existing Agent Governor's ignored receipts.
// This is NOT an executor, scheduler, approval or publication authority.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..', 'data', 'runtime', 'smoke-results', 'agent-governor');
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SHA = /^[a-f0-9]{40}$/;
const STATES = new Set([
  'PREFLIGHT', 'QUOTA_BLOCKED', 'RUNNING', 'EXECUTED_NOT_QUALIFIED',
  'UNKNOWN_EXECUTION_OUTCOME_NO_RETRY', 'MODEL_OR_EFFORT_UNVERIFIED_NO_RETRY',
  'QUALIFYING', 'QUALIFICATION_FAILED', 'SOURCE_DRIFT_AFTER_QUALIFICATION',
  'QUALIFIED', 'COMMITTING', 'LOCAL_COMMIT', 'PUBLISHED', 'STOP_REVIEW_REQUIRED'
]);
const MAX_RECEIPT_BYTES = 64 * 1024;

function safeTimestamp(value) {
  if (typeof value !== 'string' || value.length > 48 || !Number.isFinite(Date.parse(value))) return null;
  return value;
}
function safeModel(value) {
  return typeof value === 'string' && /^gpt-[A-Za-z0-9._-]{1,64}$/.test(value) ? value : null;
}
function evidenceProjection(receipt, runId) {
  if (!RUN_ID.test(runId) || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.schema !== 'eveos.agent-governor.v1') return null;
  const state = STATES.has(receipt.state) ? receipt.state : 'UNKNOWN';
  return {
    runId, state, updatedAt: safeTimestamp(receipt.updatedAt),
    branch: receipt.branch === 'eve/nexus-machine-spaces' ? receipt.branch : null,
    expectedHead: SHA.test(receipt.expectedHead || '') ? receipt.expectedHead : null,
    model: safeModel(receipt.plan?.model),
    effort: ['low', 'medium', 'high'].includes(receipt.plan?.effort) ? receipt.plan.effort : null,
    quotaPermitted: typeof receipt.dispatchDecision?.permitted === 'boolean' ? receipt.dispatchDecision.permitted : null,
    published: state === 'PUBLISHED' && SHA.test(receipt.published || '') ? receipt.published : null,
    // Never return mission text, prompts, log bodies, local paths, hashes or file lists.
  };
}
function inspectGovernorRuns({ evidenceRoot = ROOT, maxRuns = 8 } = {}) {
  const result = { schema: 'eveos.machine-governor-evidence.v1', authority: 'read-only-local-snapshot', runs: [] };
  const limit = Math.max(1, Math.min(16, Number.isInteger(maxRuns) ? maxRuns : 8));
  try {
    if (!fs.existsSync(evidenceRoot)) return { ...result, state: 'EMPTY' };
    if (!fs.lstatSync(evidenceRoot).isDirectory() || fs.lstatSync(evidenceRoot).isSymbolicLink())
      return { ...result, state: 'UNAVAILABLE' };
    const root = fs.realpathSync(evidenceRoot);
    const candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory() && RUN_ID.test(item.name))
      .sort((a, b) => b.name.localeCompare(a.name)).slice(0, 128);
    for (const candidate of candidates) {
      const folder = path.join(root, candidate.name);
      if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) continue;
      if (fs.realpathSync(folder) !== folder) continue;
      const file = path.join(folder, 'receipt.json');
      if (!fs.existsSync(file)) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) continue;
      if (fs.realpathSync(file) !== file) continue;
      let projection;
      try { projection = evidenceProjection(JSON.parse(fs.readFileSync(file, 'utf8')), candidate.name); }
      catch { continue; }
      if (projection) result.runs.push(projection);
    }
    result.runs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    result.runs = result.runs.slice(0, limit);
    return { ...result, state: result.runs.length ? 'AVAILABLE' : 'EMPTY' };
  } catch { return { ...result, state: 'UNAVAILABLE', runs: [] }; }
}

module.exports = { evidenceProjection, inspectGovernorRuns };
