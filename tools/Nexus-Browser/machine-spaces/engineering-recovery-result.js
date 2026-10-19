'use strict';

// The shared Python engine writes one direct, ignored directory per run:
// data/runtime/smoke-results/tlo-autorecover-<timestamp>-<nonce>/receipt.json.
// Keep this exact so unrelated output cannot fabricate a projected receipt.
const RECEIPT = /(?:^|\r?\n)RECEIPT\s+(data\/runtime\/smoke-results\/tlo-autorecover-[A-Za-z0-9_-]+\/receipt\.json)\s*(?:\r?\n|$)/;

function recoveryProjection(result = {}) {
  const text = `${String(result.stdout || '')}\n${String(result.stderr || '')}`;
  const match = text.match(RECEIPT);
  if (!match) return null;
  const receipt = match[1];
  if (receipt.split('/').some((part) => part === '..')) return null;
  return Object.freeze({ schema: 'eveos.machine-spaces.recovery-result.v1',
    outcome: /(?:^|\r?\n)TLO_AUTORECOVERY GREEN\s*(?:\r?\n|$)/.test(text) ? 'GREEN' : 'RECORDED',
    receipt });
}

module.exports = { recoveryProjection };
