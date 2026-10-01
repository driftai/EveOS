'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const doctor = fs.readFileSync(path.join(ROOT, 'scripts', 'app-origin-doctor.js'), 'utf8');

test('live App-Origin qualification requires an exact native conversation identity', () => {
  assert.match(pkg.scripts['qualify:app-origin:live'], /--require-conversation/);
  assert.match(doctor, /APP_CONVERSATION_IDENTITY_MISSING/);
  assert.match(doctor, /activeConversationTitle/);
});

test('ordinary app doctor remains usable without forcing a conversation', () => {
  assert.equal(pkg.scripts['doctor:apps'], 'node scripts/app-origin-doctor.js');
});
