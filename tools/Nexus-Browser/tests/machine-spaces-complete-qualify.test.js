'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { statusForExit, aggregateStatus } = require('../scripts/machine-spaces-complete-qualify');

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
