'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateProof } = require('../machine-spaces/trusted-terminal-attachment');
const { createExternalTerminalProcessAdapter } = require('../machine-spaces/external-terminal-process-adapter');
const { enhanceMachineSpacesTrustedAttachController } = require('../machine-spaces/server-controller-trusted-attach');

function socket() {
  const handlers = new Map();
  return { once(name, fn) { handlers.set(name, fn); }, emit(name) { handlers.get(name)?.(); } };
}

function processFixture() {
  let generation = '20261008123456.000000-240';
  let alive = true;
  const taskkills = [];
  const adapter = createExternalTerminalProcessAdapter({
    platform: 'win32',
    inspectProcess(pid) {
      if (!alive) return null;
      return { pid, startedAt: generation, executablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', commandLine: 'powershell.exe' };
    },
    spawnSync(file, args) {
      taskkills.push({ file, args });
      alive = false;
      return { status: 0, stdout: 'SUCCESS', stderr: '' };
    }
  });
  return {
    adapter,
    taskkills,
    replaceProcess() { generation = '20261008123500.000000-240'; alive = true; },
    alive: () => alive
  };
}

test('external terminal adapter pins PID reuse to an exact process epoch', () => {
  const f = processFixture();
  const target = f.adapter.probe({ pid: 4242, cwd: 'C:\\repo', shellType: 'powershell', adapterId: 'adapter-one' });
  assert.equal(target.targetId, 'external-pid-4242');
  assert.match(target.processEpoch, /^external-process:4242:/);
  assert.equal(f.adapter.observe(target).alive, true);

  f.replaceProcess();
  assert.throws(() => f.adapter.observe(target), { code: 'MACHINE_EXTERNAL_PROCESS_EPOCH_MISMATCH' });
  assert.throws(() => f.adapter.interrupt(target), { code: 'MACHINE_EXTERNAL_PROCESS_EPOCH_MISMATCH' });
  assert.equal(f.taskkills.length, 0, 'stale PID epoch must never be interrupted');
});

test('Windows external interrupt uses taskkill tree and exposes no execute primitive', () => {
  const f = processFixture();
  const target = f.adapter.probe({ pid: 5151, cwd: 'C:\\repo', shellType: 'powershell', adapterId: 'adapter-one' });
  const result = f.adapter.interrupt(target);
  assert.deepEqual(result, { accepted: true, pid: 5151, method: 'taskkill-tree' });
  assert.deepEqual(f.taskkills, [{ file: 'taskkill.exe', args: ['/pid', '5151', '/t', '/f'] }]);
  assert.equal(typeof f.adapter.execute, 'undefined');
});

function controllerFixture() {
  const owner = socket(), outsider = socket();
  const uiSockets = new Set([owner]);
  const sent = new Map();
  const safeSend = (ws, payload) => { const values = sent.get(ws) || []; values.push(payload); sent.set(ws, values); return true; };
  const processCalls = { observe: [], interrupt: [] };
  const exactTarget = {
    pid: 6001,
    targetId: 'external-pid-6001',
    processEpoch: 'external-process:6001:stamp-one',
    startedAt: 'stamp-one',
    executablePath: 'powershell.exe',
    commandLine: 'powershell.exe',
    cwd: 'C:\\repo',
    shellType: 'powershell',
    adapterId: 'adapter-one'
  };
  const externalTerminalProcessAdapter = {
    probe(input) { return { ...exactTarget, adapterId: input.adapterId, cwd: input.cwd, shellType: input.shellType }; },
    observe(input) { processCalls.observe.push(input); return { alive: true, pid: 6001, targetId: exactTarget.targetId, processEpoch: exactTarget.processEpoch }; },
    interrupt(input) { processCalls.interrupt.push(input); return { accepted: true, pid: 6001, method: 'taskkill-tree' }; }
  };
  const base = { handle: async () => false, providerControl: { owns: () => false, route: () => false }, stop() {} };
  const controller = enhanceMachineSpacesTrustedAttachController(() => base, {
    uiSockets, safeSend, externalTerminalProcessAdapter
  });
  const messages = (ws) => sent.get(ws) || [];
  return { controller, owner, outsider, messages, processCalls, exactTarget };
}

async function trustedFixture(f) {
  await f.controller.handle(f.owner, { type: 'machine_register_trusted_adapter', adapterId: 'adapter-one' });
  const registered = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_adapter_registered');
  await f.controller.handle(f.owner, {
    type: 'machine_probe_external_terminal', adapterId: 'adapter-one', pid: 6001,
    cwd: 'C:\\repo', shellType: 'powershell', requestId: 'probe-one'
  });
  const target = f.messages(f.owner).find((msg) => msg.type === 'machine_external_terminal_probe').target;
  await f.controller.handle(f.owner, {
    type: 'machine_begin_trusted_attach', adapterId: 'adapter-one', targetId: target.targetId,
    processEpoch: target.processEpoch, ownerId: 'owner-one', cwd: target.cwd, shellType: target.shellType
  });
  const challenge = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_attach_challenge').challenge;
  await f.controller.handle(f.owner, {
    type: 'machine_attest_trusted_attach', challengeId: challenge.challengeId,
    ownerId: 'owner-one', proof: calculateProof(challenge, registered.adapterSecret)
  });
  return f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_attach_changed' && msg.action === 'trusted').attachment;
}

test('trusted attachment routes observe and interrupt through exact external process adapter', async () => {
  const f = controllerFixture();
  const attachment = await trustedFixture(f);
  assert.deepEqual(attachment.capabilities, ['observe', 'interrupt']);

  await f.controller.handle(f.owner, {
    type: 'machine_trusted_attach_observe', attachmentId: attachment.attachmentId, requestId: 'observe-one'
  });
  const observation = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_attach_observation');
  assert.equal(observation.observation.alive, true);
  assert.equal(f.processCalls.observe.length, 2, 'attestation verifies epoch once, then explicit observe runs once');

  await f.controller.handle(f.owner, {
    type: 'machine_trusted_attach_interrupt', attachmentId: attachment.attachmentId, requestId: 'interrupt-one'
  });
  const interrupted = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_attach_interrupt_result');
  assert.equal(interrupted.result.accepted, true);
  assert.equal(f.processCalls.interrupt.length, 1);
});

test('untrusted local process control and execute-shaped messages do not gain authority', async () => {
  const f = controllerFixture();
  await f.controller.handle(f.outsider, {
    type: 'machine_probe_external_terminal', adapterId: 'adapter-one', pid: 6001, cwd: 'C:\\repo', shellType: 'powershell'
  });
  assert.equal(f.messages(f.outsider).at(-1).code, 'MACHINE_LOCAL_OWNER_REQUIRED');

  const handled = await f.controller.handle(f.owner, {
    type: 'machine_trusted_attach_execute', attachmentId: 'anything', command: 'whoami'
  });
  assert.equal(handled, false, 'trusted attachment controller must not implement execute');
  assert.equal(f.processCalls.interrupt.length, 0);
});
