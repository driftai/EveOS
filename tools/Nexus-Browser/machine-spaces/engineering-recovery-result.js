'use strict';

const RECEIPT = /(?:^|\r?\n)RECEIPT\s+(data\/runtime\/smoke-results\/tlo-autorecovery\/[A-Za-z0-9_.\/-]+\/receipt\.json)\s*(?:\r?\n|$)/;

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
