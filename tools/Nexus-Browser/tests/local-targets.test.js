const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  TARGET_ID,
  TARGET_TYPE_ID,
  resolveGeminiLaunch,
  publicTarget,
  parseStreamLine,
  createStreamAccumulator
} = require('../local-targets/gemini-cli');
const manager = require('../local-targets/manager');

test('Local-Origin registry exposes online/local classes and terminal-agent type', () => {
  assert.deepEqual(manager.publicTargetClasses().map((entry) => entry.id), ['online-origin', 'local-origin']);
  assert.deepEqual(manager.publicLocalTargetTypes().map((entry) => entry.id), ['terminal-agent', 'provider-workspace']);
});

test('local target normalization preserves provider-neutral surface and exact identity metadata', () => {
  const target = manager.normalizeLocalTarget({
    id: 'local:antigravity-existing:4242', targetTypeId: 'terminal-agent',
    providerId: 'local-antigravity-existing', transport: 'windows-console-attach',
    sessionOrigin: 'existing', pid: 4242, executablePath: 'C:\\Tools\\agy.exe',
    capabilities: { chat: true }
  });
  assert.equal(target.targetClassId, 'local-origin');
  assert.equal(target.targetTypeId, 'terminal-agent');
  assert.equal(target.transport, 'windows-console-attach');
  assert.equal(target.sessionOrigin, 'existing');
  assert.deepEqual(target.concreteTargetIdentity, {
    kind: 'windows-process', targetId: 'local:antigravity-existing:4242',
    processId: 4242, executablePath: 'C:\\Tools\\agy.exe'
  });
});

test('Gemini CLI target metadata is isolated under Local-Origin', () => {
  const target = publicTarget({ command: 'gemini', prefixArgs: [], source: 'gemini' });
  assert.equal(target.id, TARGET_ID);
  assert.equal(target.targetClassId, 'local-origin');
  assert.equal(target.targetTypeId, TARGET_TYPE_ID);
  assert.equal(target.providerId, 'local-gemini-cli');
  assert.equal(target.capabilities.chat, true);
  assert.equal(target.capabilities.captureLatest, false);
});

test('Windows Gemini CLI shim resolves to node entry when installed through npm', () => {
  const shim = 'C:\\Users\\Drift\\AppData\\Roaming\\npm\\gemini.cmd';
  const expectedEntry = path.join(path.dirname(shim), 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');
  const launch = resolveGeminiLaunch({
    platform: 'win32',
    exists: (candidate) => candidate === expectedEntry,
    spawnSyncImpl: () => ({ status: 0, stdout: `${shim}\r\n` })
  });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.prefixArgs, [expectedEntry]);
  assert.equal(launch.source, shim);
});

test('Windows Gemini CLI shim supports bundle/gemini.js entry and filters extensionless wrappers', () => {
  const unixWrapper = 'C:\\Users\\Drift\\AppData\\Roaming\\npm\\gemini';
  const shim = 'C:\\Users\\Drift\\AppData\\Roaming\\npm\\gemini.cmd';
  const bundleEntry = path.join(path.dirname(shim), 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
  const launch = resolveGeminiLaunch({
    platform: 'win32',
    exists: (candidate) => candidate === bundleEntry,
    spawnSyncImpl: () => ({ status: 0, stdout: `${unixWrapper}\r\n${shim}\r\n` })
  });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.prefixArgs, [bundleEntry]);
  assert.equal(launch.source, shim);
});

test('stream-json parser ignores non-JSON and accepts Gemini CLI events', () => {
  assert.equal(parseStreamLine('not-json'), null);
  assert.deepEqual(parseStreamLine('{"type":"message","role":"assistant","content":"Hi"}'), {
    type: 'message', role: 'assistant', content: 'Hi'
  });
});

test('Gemini CLI stream events become partial/final response plus visible tool activity', () => {
  const emitted = [];
  const target = publicTarget({ command: 'gemini', prefixArgs: [], source: 'gemini' });
  const stream = createStreamAccumulator({ requestId: 'local-1', target, emit: (event) => emitted.push(event) });

  stream.handle({ type: 'message', role: 'assistant', content: 'Hello ', delta: true });
  stream.handle({ type: 'tool_use', tool_name: 'read_file', parameters: { path: 'README.md' } });
  stream.handle({ type: 'tool_result', status: 'success', output: 'done' });
  stream.handle({ type: 'message', role: 'assistant', content: 'world', delta: true });
  stream.handle({ type: 'result', status: 'success', stats: {} });

  const partials = emitted.filter((event) => event.type === 'response_partial');
  const final = emitted.find((event) => event.type === 'response_final');
  const activity = emitted.filter((event) => event.type === 'activity_update');

  assert.deepEqual(partials.map((event) => event.text), ['Hello ', 'Hello world']);
  assert.equal(final.text, 'Hello world');
  assert.equal(final.targetClassId, 'local-origin');
  assert.ok(activity.some((event) => event.activity.events.some((item) => item.label === 'Tool: read_file')));
  assert.ok(activity.some((event) => event.activity.events.some((item) => item.label === 'Tool result: success')));
});

test('Gemini CLI result error surfaces as bridge error instead of false final', () => {
  const emitted = [];
  const target = publicTarget({ command: 'gemini', prefixArgs: [], source: 'gemini' });
  const stream = createStreamAccumulator({ requestId: 'local-error', target, emit: (event) => emitted.push(event) });

  stream.handle({ type: 'result', status: 'error', error: { message: 'session unavailable' } });

  assert.equal(emitted.some((event) => event.type === 'response_final'), false);
  const error = emitted.find((event) => event.type === 'error');
  assert.equal(error.code, 'LOCAL_AGENT_ERROR');
  assert.match(error.message, /session unavailable/);
});

test('Gemini CLI nonzero exit extracts salient error from stderr', () => {
  const emitted = [];
  const target = publicTarget({ command: 'gemini', prefixArgs: [], source: 'gemini' });
  const stream = createStreamAccumulator({ requestId: 'local-exit', target, emit: (event) => emitted.push(event) });

  stream.finish(1, 'Warning: 256-color support not detected.\nError authenticating: IneligibleTierError: This client is no longer supported.\n    at throwError()');

  const error = emitted.find((event) => event.type === 'error');
  assert.ok(error, 'Should emit error event');
  assert.equal(error.code, 'LOCAL_AGENT_EXITED');
  assert.equal(error.message, 'Error authenticating: IneligibleTierError: This client is no longer supported.');
});

