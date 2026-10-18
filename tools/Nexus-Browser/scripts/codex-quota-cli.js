#!/usr/bin/env node
'use strict';
const { freshQuota, dispatchPolicy } = require('../local-targets/codex-quota');

async function main(argv = process.argv.slice(2)) {
  const strict = argv.includes('--require-fresh');
  const index = argv.indexOf('--min-remaining');
  const minRemaining = index >= 0 ? Number(argv[index + 1]) : 5;
  const allowed = new Set(['--require-fresh', '--min-remaining']);
  if (argv.some((arg, i) => !allowed.has(arg) && !(index >= 0 && i === index + 1)) || !Number.isFinite(minRemaining) || minRemaining < 0 || minRemaining > 100) {
    process.stderr.write('Usage: codex-quota-cli [--require-fresh] [--min-remaining 0..100]\n');
    return 2;
  }
  const snapshot = await freshQuota({ maxAgeMs: 0 });
  const policy = dispatchPolicy(snapshot, { unattended: strict, minRemaining });
  process.stdout.write(JSON.stringify({ ...snapshot, dispatch: policy }, null, 2) + '\n');
  return policy.permitted ? 0 : 3;
}
if (require.main === module) main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 2; });
module.exports = { main };
