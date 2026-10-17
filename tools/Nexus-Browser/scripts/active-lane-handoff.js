'use strict';

// Explicit active-lane handoff verification. This never replaces strict main
// rollover. Fetch is a readback fence, not permission to mutate or publish.
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!.*(?:\/\/|\.\.|@\{|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function assertLane(branch, expectedHead) {
  if (!BRANCH.test(branch) || branch.endsWith('/') || branch === 'main') {
    throw Error('Require a valid explicitly authorized non-main working branch.');
  }
  if (!SHA.test(expectedHead)) {
    throw Error('Require an exact lowercase 40-character expected HEAD.');
  }
}

function parseArgs(argv = []) {
  let verify = false, branch = null, expectedHead = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') {
      if (verify) throw Error('Duplicate --verify.');
      verify = true;
      continue;
    }
    if (arg !== '--branch' && arg !== '--sha') throw Error(`Unknown option: ${arg}`);
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) {
      throw Error(`Missing value for ${arg}`);
    }
    if (arg === '--branch') {
      if (branch !== null) throw Error('Duplicate --branch.');
      branch = argv[++i];
    } else {
      if (expectedHead !== null) throw Error('Duplicate --sha.');
      expectedHead = argv[++i];
    }
  }
  if (branch !== null || expectedHead !== null) {
    if (!verify || branch === null || expectedHead === null) {
      throw Error('Active-lane verification requires --verify --branch NAME --sha EXACT40.');
    }
    assertLane(branch, expectedHead);
  }
  return branch !== null ? { verify, branch, expectedHead } : { verify };
}

function verifyActiveLane(repoState, { branch, expectedHead }, gitCommand) {
  assertLane(branch, expectedHead);
  if (typeof gitCommand !== 'function') throw Error('A trusted Git command owner is required.');
  const ref = `refs/remotes/origin/${branch}`;
  const refspec = `refs/heads/${branch}:${ref}`;
  const fetched = gitCommand(['fetch', '--quiet', '--no-tags', 'origin', refspec]) !== null;
  const remoteHead = fetched ? gitCommand(['rev-parse', '--verify', ref]) : null;
  const issues = [];
  if (repoState?.branch !== branch) issues.push('working branch differs from authorized branch');
  if (repoState?.clean !== true) issues.push('working tree is not clean');
  if (repoState?.head !== expectedHead) issues.push('local HEAD differs from expected SHA');
  if (!fetched) issues.push('remote fetch unavailable; do not trust cached refs');
  if (fetched && remoteHead !== expectedHead) issues.push('fetched remote SHA differs from expected SHA');
  return {
    mode: 'authorized-active-lane',
    ok: issues.length === 0,
    branch,
    expectedHead,
    localHead: repoState?.head || null,
    remoteHead,
    originFetchAttempted: true,
    originFetchOk: fetched,
    remoteFreshness: fetched ? 'fetched-now' : 'unavailable',
    checkedAt: new Date().toISOString(),
    issues
  };
}

module.exports = { SHA, BRANCH, assertLane, parseArgs, verifyActiveLane };
