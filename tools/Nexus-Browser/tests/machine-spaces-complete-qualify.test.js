'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  statusForExit,
  aggregateStatus,
  childArgs
} = require('../scripts/machine-spaces-complete-qualify');

test('complete qualifier maps process exits to pass, blocked and fail', () => {
  assert.equal(statusForExit(0), 'PASS');
  assert.equal(statusForExit(2), 'BLOCKED');
  assert.equal(statusForExit(1), 'FAIL');
  assert.equal(statusForExit(null), 'FAIL');
});

test('complete qualifier never hides a failure behind a blocked provider lane', () => {
  assert.equal(aggregateStatus([{ status: 'PASS' }, { status: 'PASS' }]), 'PASS');
  assert.equal(aggregateStatus([{ status: 'PASS' }, { status: 'BLOCKED' }]), 'BLOCKED');
  assert.equal(aggregateStatus([{ status: 'FAIL' }, { status: 'BLOCKED' }]), 'FAIL');
});

test('complete qualifier forwards warm target and provider pins to the right child lanes', () => {
  const args = childArgs([
    '--warm-tab-id', '116817255',
    '--hark-tab-id', '44',
    '--source-target-id', 'local-2',
    '--timeout-ms', '240000'
  ]);
  assert.deepEqual(args.allLive, [
    '--chatgpt-live', '--external-live',
    '--timeout-ms', '240000',
    '--warm-tab-id', '116817255'
  ]);
  assert.deepEqual(args.providers, [
    '--timeout-ms', '240000',
    '--source-target-id', 'local-2',
    '--hark-tab-id', '44'
  ]);
});

test('complete qualifier can skip quorum without weakening the warm ChatGPT lane', () => {
  const args = childArgs(['--warm-tab-id', '9', '--skip-quorum']);
  assert.deepEqual(args.allLive, ['--chatgpt-live', '--external-live', '--warm-tab-id', '9']);
  assert.deepEqual(args.providers, ['--skip-quorum']);
});
