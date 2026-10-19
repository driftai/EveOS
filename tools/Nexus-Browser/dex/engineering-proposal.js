'use strict';

const SCHEMA = 'eveos.machine-spaces.engineering-proposal.v1';
const RETRY = new Set(['none', 'after-verified-repair', 'requires-approval']);
const REPAIR = new Set(['none', 'prepare-command', 'source-patch', 'await-approval']);

function bounded(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function fail(code, message) { return { ok: false, schema: SCHEMA, code, message }; }
function jsonObject(text) {
  const raw = String(text || '').trim();
  if (raw.length > 12000) return null;
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    const parsed = JSON.parse(fenced ? fenced[1] : raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
function validateEngineeringProposal(text, incident = {}) {
  const value = jsonObject(text);
  if (!value) return fail('ENGINEERING_PROPOSAL_JSON_REQUIRED', 'Reply must be one bounded JSON object.');
  if (value.schema !== SCHEMA) return fail('ENGINEERING_PROPOSAL_SCHEMA_INVALID', `schema must be ${SCHEMA}.`);
  if (String(value.incidentJobId || '') !== String(incident.jobId || ''))
    return fail('ENGINEERING_PROPOSAL_JOB_MISMATCH', 'Proposal does not name the exact incident job.');
  const summary = bounded(value.summary, 1200);
  if (!summary) return fail('ENGINEERING_PROPOSAL_SUMMARY_REQUIRED', 'A bounded diagnosis summary is required.');
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    return fail('ENGINEERING_PROPOSAL_CONFIDENCE_INVALID', 'confidence must be between 0 and 1.');
  const retryIntent = bounded(value.retryIntent, 40);
  if (!RETRY.has(retryIntent)) return fail('ENGINEERING_PROPOSAL_RETRY_INVALID', 'retryIntent is not recognized.');
  const repair = value.repair && typeof value.repair === 'object' && !Array.isArray(value.repair) ? value.repair : {};
  const repairKind = bounded(repair.kind, 40);
  if (!REPAIR.has(repairKind)) return fail('ENGINEERING_PROPOSAL_REPAIR_INVALID', 'repair.kind is not recognized.');
  const requestedEvidence = Array.isArray(value.requestedEvidence)
    ? value.requestedEvidence.slice(0, 8).map((item) => bounded(item, 180)).filter(Boolean) : [];
  const paths = Array.isArray(repair.paths)
    ? repair.paths.slice(0, 16).map((item) => bounded(item, 260)).filter(Boolean) : [];
  if (paths.some((item) => /(^|[\\/])\.\.([\\/]|$)/.test(item) || /^[A-Za-z]:[\\/]/.test(item)))
    return fail('ENGINEERING_PROPOSAL_PATH_INVALID', 'Repair paths must remain relative and traversal-free.');
  return { ok: true, schema: SCHEMA, incidentJobId: String(value.incidentJobId),
    classification: bounded(value.classification, 96) || null, summary, confidence, requestedEvidence,
    repair: { kind: repairKind, paths, description: bounded(repair.description, 1000) || null }, retryIntent };
}

module.exports = { SCHEMA, RETRY, REPAIR, validateEngineeringProposal };
