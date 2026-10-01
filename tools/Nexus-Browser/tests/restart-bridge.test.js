const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const restart = require('../scripts/restart-bridge');

test('restart helper parses the Nexus listener PID from netstat', () => {
  const sample = [
    '  TCP    127.0.0.1:9088         0.0.0.0:0              LISTENING       123456',
    '  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       999'
  ].join('\r\n');
  assert.equal(restart.listenerPidFromNetstat(sample, 9088), 123456);
});

test('restart helper verifies both EveOS checkout and expected command fragment', () => {
  const root = path.resolve(__dirname, '..').replace(/\//g, '\\');
  assert.equal(restart.ownsExpectedProcess({
    CommandLine: `node "${root}\\server.js"`
  }, 'server.js'), true);
  assert.equal(restart.ownsExpectedProcess({
    CommandLine: 'node C:\\Other\\server.js'
  }, 'server.js'), false);
  assert.equal(restart.ownsExpectedProcess({
    CommandLine: `node "${root}\\scripts\\bridge-supervisor.js"`
  }, 'bridge-supervisor.js'), true);
});
