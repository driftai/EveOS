'use strict';

const RECEIPT = /^data\/runtime\/smoke-results\/tlo-autorecover-[A-Za-z0-9_-]+\/receipt\.json$/;

function validateEngineeringCompletion(text, verification = {}, done = false) {
  const value = String(text || '');
  if (!verification || verification.schema !== 'eveos.machine-spaces.engineering-verification.v1')
    return { ok: false, code: 'ENGINEERING_VERIFICATION_SOURCE_REQUIRED' };
  if (verification.state !== 'completed' || Number(verification.exitCode) !== 0
      || verification.outcome !== 'GREEN' || !RECEIPT.test(String(verification.receipt || '')))
    return { ok: false, code: 'ENGINEERING_VERIFICATION_NOT_GREEN' };
  if (!done) return { ok: false, code: 'ENGINEERING_DONE_MARKER_REQUIRED' };
  for (const token of [verification.jobId, verification.outputId, verification.receipt]) {
    if (!token || !value.includes(String(token)))
      return { ok: false, code: 'ENGINEERING_EVIDENCE_BINDING_REQUIRED' };
  }
  if (!/\bGREEN\b/u.test(value)) return { ok: false, code: 'ENGINEERING_GREEN_CLAIM_REQUIRED' };
  return { ok: true, code: 'ENGINEERING_COMPLETION_VERIFIED', jobId: verification.jobId,
    outputId: verification.outputId, receipt: verification.receipt };
}

module.exports = { RECEIPT, validateEngineeringCompletion };
