'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, verifyActiveLane } = require('../scripts/active-lane-handoff');
const { strictRollover } = require('../scripts/handoff');

const branch = 'eve/nexus-machine-spaces';
const sha = '0'.repeat(40);
const goodRepo = { branch, head: sha, clean: true };

function remote(shaFromRemote = sha, fetchOk = true) {
  const calls = [];
  function git(args) {
    calls.push(args);
    if (args[0] === 'fetch') return fetchOk ? '' : null;
    if (args[0] === 'rev-parse') return shaFromRemote;
    throw Error('Unexpected Git operation');
  }
  return { git, calls };
}

test('normal handoff and strict main verification keep legacy semantics', () => {
  assert.deepEqual(parseArgs([]), { verify: false });
  assert.deepEqual(parseArgs(['--verify']), { verify: true });
  assert.equal(strictRollover({
    branch: 'main', clean: true, originFetchOk: true, headMatchesOriginMain: true
  }).ok, true);
  assert.equal(strictRollover({
    branch, clean: true, originFetchOk: true, headMatchesOriginMain: true
  }).ok, false);
});

test('active-lane verification requires explicit bounded branch and exact SHA', () => {
  assert.deepEqual(parseArgs(['--verify', '--branch', branch, '--sha', sha]), {
    verify: true, branch, expectedHead: sha
  });
  for (const args of [
    ['--branch', branch, '--sha', sha],
    ['--verify', '--branch', branch],
    ['--verify', '--sha', sha],
    ['--verify', '--branch', 'main', '--sha', sha],
    ['--verify', '--branch', '../evil', '--sha', sha],
    ['--verify', '--branch', branch, '--sha', 'abcd'],
    ['--verify', '--verify'],
    ['--verify', '--branch', branch, '--branch', branch, '--sha', sha],
    ['--unknown']
  ]) assert.throws(() => parseArgs(args));
});

test('active-lane verification fetches exact remote branch before matching', () => {
  const source = remote();
  const result = verifyActiveLane(goodRepo, { branch, expectedHead: sha }, source.git);
  assert.equal(result.ok, true);
  assert.equal(result.remoteFreshness, 'fetched-now');
  assert.deepEqual(source.calls, [
    ['fetch', '--quiet', '--no-tags', 'origin',
      'refs/heads/eve/nexus-machine-spaces:refs/remotes/origin/eve/nexus-machine-spaces'],
    ['rev-parse', '--verify', 'refs/remotes/origin/eve/nexus-machine-spaces']
  ]);
});

test('offline verification never upgrades cached SHA to fresh', () => {
  const source = remote(sha, false);
  const result = verifyActiveLane(goodRepo, { branch, expectedHead: sha }, source.git);
  assert.equal(result.ok, false);
  assert.equal(result.remoteHead, null);
  assert.equal(result.remoteFreshness, 'unavailable');
  assert.equal(source.calls.length, 1);
});

test('remote drift, local drift, wrong branch and dirty tree fail closed', () => {
  const changed = 'f'.repeat(40);
  assert.equal(verifyActiveLane(goodRepo, { branch, expectedHead: sha }, remote(changed).git).ok, false);
  assert.equal(verifyActiveLane({ ...goodRepo, head: changed }, { branch, expectedHead: sha }, remote().git).ok, false);
  assert.equal(verifyActiveLane({ ...goodRepo, branch: 'main' }, { branch, expectedHead: sha }, remote().git).ok, false);
  assert.equal(verifyActiveLane({ ...goodRepo, clean: false }, { branch, expectedHead: sha }, remote().git).ok, false);
});
