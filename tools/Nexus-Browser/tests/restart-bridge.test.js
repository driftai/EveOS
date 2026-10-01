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

test('restart helper keeps netstat parsing only as a compatibility fallback', () => {
  assert.equal(restart.listenerPidFromNetstat(
    'TCP    127.0.0.1:9088    0.0.0.0:0    LISTENING    77777',
    9088
  ), 77777);
  assert.equal(typeof restart.readSupervisorPidFile, 'function');
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
  assert.equal(restart.commandHas({
    CommandLine: 'node  scripts\\bridge-supervisor.js'
  }, 'bridge-supervisor.js'), true);
});


test('restart helper trusts the verified live server parent over a stale supervisor pid file', () => {
  const root = path.resolve(__dirname, '..').replace(/\//g, '\\');
  const server = {
    ProcessId: 116376,
    ParentProcessId: 121672,
    ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
    CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "${root}\\server.js"`
  };
  const parent = {
    ProcessId: 121672,
    ParentProcessId: 555,
    ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
    CommandLine: 'node  scripts\\bridge-supervisor.js'
  };
  const stale = {
    ProcessId: 101424,
    ParentProcessId: 555,
    ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
    CommandLine: 'node scripts\\bridge-supervisor.js'
  };
  const selected = restart.chooseSupervisor({ server, parent, pidFile: stale });
  assert.equal(selected.supervisor?.ProcessId, 121672);
  assert.equal(selected.source, 'parent');
  assert.equal(selected.stalePidFile, true);
});

test('restart helper rejects a non-node or non-supervisor parent even when it owns the server process', () => {
  const server = { ProcessId: 10, ParentProcessId: 20 };
  assert.equal(restart.verifiedSupervisorParent(server, {
    ProcessId: 20,
    ExecutablePath: 'C:\\Windows\\System32\\cmd.exe',
    CommandLine: 'cmd.exe /c something'
  }), false);
  assert.equal(restart.chooseSupervisor({ server, parent: {
    ProcessId: 20,
    ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
    CommandLine: 'node scripts\\unrelated.js'
  }}).supervisor, null);
});
