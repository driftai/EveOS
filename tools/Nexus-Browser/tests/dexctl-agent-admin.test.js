const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, sourceFrom, commandFrom, runExtensionReload, shouldRetryResult, runWithRetry } = require('../scripts/dexctl');

test('dexctl exposes self-service onboarding with optional room selection', () => {
  assert.deepEqual(commandFrom(parseArgs(['onboard'])), { action: 'onboard' });
  assert.deepEqual(commandFrom(parseArgs(['onboard', '--room', 'Eve + Muse Live'])), {
    action: 'onboard',
    room: 'Eve + Muse Live'
  });
});

test('dexctl exposes self rename and observer participation controls', () => {
  assert.deepEqual(commandFrom(parseArgs(['rename-self', 'Astro', 'Observer', '--room', 'Core Room'])), {
    action: 'rename_self',
    name: 'Astro Observer',
    room: 'Core Room'
  });
  assert.deepEqual(commandFrom(parseArgs(['relay-self', 'off', '--room', 'Core Room'])), {
    action: 'set_self_relay',
    enabled: false,
    room: 'Core Room'
  });
  assert.deepEqual(commandFrom(parseArgs(['relay-self', 'on'])), {
    action: 'set_self_relay',
    enabled: true
  });
  assert.throws(() => commandFrom(parseArgs(['relay-self', 'maybe'])), /requires on or off/);
});

test('dexctl exposes target discovery and room creation commands', () => {
  assert.deepEqual(commandFrom(parseArgs(['targets'])), { action: 'targets' });
  assert.deepEqual(commandFrom(parseArgs(['create-room', 'Eve', '+', 'Muse'])), {
    action: 'create_room',
    name: 'Eve + Muse'
  });
});

test('dexctl exposes room-history clearing with optional room selection', () => {
  assert.deepEqual(commandFrom(parseArgs(['clear-chat'])), { action: 'clear_chat' });
  assert.deepEqual(commandFrom(parseArgs(['clear-chat', '--room', 'Eve + Muse'])), {
    action: 'clear_chat',
    room: 'Eve + Muse'
  });
});

test('dexctl exposes explicit room deletion', () => {
  assert.deepEqual(commandFrom(parseArgs(['delete-room', 'Old', 'Room'])), {
    action: 'delete_room',
    room: 'Old Room'
  });
  assert.throws(() => commandFrom(parseArgs(['delete-room'])), /requires a room id or exact name/);
});

test('dexctl add-agent carries an exact visible target binding', () => {
  assert.deepEqual(
    commandFrom(parseArgs([
      'add-agent',
      '--room', 'Eve + Muse',
      '--target-class', 'online-origin',
      '--target-id', '30',
      '--provider-id', 'muse',
      '--name', 'Muse'
    ])),
    {
      action: 'add_agent',
      room: 'Eve + Muse',
      targetClassId: 'online-origin',
      targetId: '30',
      providerId: 'muse',
      name: 'Muse'
    }
  );
});

test('dexctl isolates local source identity when adding an online agent', () => {
  const parsed = parseArgs([
    'add-agent',
    '--room', 'Eve + Muse',
    '--target-class', 'online-origin',
    '--target-id', '116806360',
    '--provider-id', 'chatgpt',
    '--name', 'Eve',
    '--agy-pid', '86660'
  ]);
  const source = sourceFrom(parsed.options, parsed.commandName);
  assert.equal(source.targetClassId, 'local-origin');
  assert.equal(source.targetId, 'local:antigravity-existing:86660');
  assert.equal(source.providerId, 'local-antigravity-existing');
  assert.equal(source.providerName, 'Antigravity CLI');
});


test('dexctl retries transient stale-Dex failures after a server restart', async () => {
  assert.equal(shouldRetryResult({ code: 'DEX_UI_OFFLINE' }, { action: 'targets' }), true);
  assert.equal(shouldRetryResult({ code: 'DEX_CONTROL_BAD_ACTION' }, { action: 'targets' }), true);
  assert.equal(shouldRetryResult({ code: 'DEX_UI_OFFLINE' }, { action: 'send' }), false);
  assert.equal(shouldRetryResult({ code: 'DEX_CONTROL_TIMEOUT' }, { action: 'send' }), false);
  assert.equal(shouldRetryResult({ code: 'DEX_CONTROL_TARGET_NOT_FOUND' }, { action: 'targets' }), false);

  const results = [
    { ok: false, code: 'DEX_UI_OFFLINE' },
    { ok: false, code: 'DEX_CONTROL_BAD_ACTION' },
    { ok: true, action: 'targets' }
  ];
  let calls = 0;
  const result = await runWithRetry({
    source: { targetClassId: 'local-origin', targetId: 'local:test', providerId: 'test' },
    command: { action: 'targets' },
    delayMs: 0,
    runImpl: async () => { calls += 1; return results.shift(); }
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});


test('dexctl resume re-enters a room as a relayed provider message', () => {
  assert.deepEqual(commandFrom(parseArgs(['resume', 'back', 'online', '--room', 'Core Room'])), {
    action: 'send',
    text: 'back online',
    relay: true,
    room: 'Core Room'
  });
});


test('reload-extension is a bridge-admin command and does not require agent source identity', () => {
  const parsed = parseArgs(['reload-extension']);
  assert.equal(parsed.commandName, 'reload-extension');
  assert.deepEqual(parsed.options, {});
});

test('runExtensionReload waits for extension disconnect then reconnect', async () => {
  const handlers = {};
  let epoch = 1;
  class FakeSocket {
    constructor() { this.sent = []; setImmediate(() => handlers.open?.()); }
    on(name, fn) { handlers[name] = fn; }
    send(value) {
      const msg = JSON.parse(value);
      this.sent.push(msg);
      if (msg.type === 'reload_extension') {
        setImmediate(() => handlers.message?.(JSON.stringify({ type: 'reloading_extension' })));
        setImmediate(() => handlers.message?.(JSON.stringify({ type: 'bridge_status', connected: false })));
        setImmediate(() => { epoch = 2; handlers.message?.(JSON.stringify({ type: 'bridge_status', connected: true })); });
      }
    }
    close() {}
  }
  const fetchImpl = async () => ({ ok: true, json: async () => ({
    extensionSessions: { primaryConnectionEpoch: epoch, standby: [] }
  }) });
  const result = await runExtensionReload(1000, FakeSocket, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'reload_extension');
});

test('runExtensionReload accepts a new connection epoch while a standby keeps the bridge online', async () => {
  const handlers = {};
  let epoch = 4;
  class FakeSocket {
    constructor() { setImmediate(() => handlers.open?.()); }
    on(name, fn) { handlers[name] = fn; }
    send(value) {
      if (JSON.parse(value).type !== 'reload_extension') return;
      setImmediate(() => handlers.message?.(JSON.stringify({ type: 'reloading_extension' })));
      setImmediate(() => { epoch = 5; handlers.message?.(JSON.stringify({ type: 'bridge_status', connected: true })); });
    }
    close() {}
  }
  const fetchImpl = async () => ({ ok: true, json: async () => ({
    extensionSessions: { primaryConnectionEpoch: epoch, standby: [{ connectionEpoch: epoch - 1 }] }
  }) });
  const result = await runExtensionReload(1000, FakeSocket, fetchImpl);
  assert.equal(result.ok, true);
});


test('dexctl exposes shared room configuration and participant management', () => {
  assert.deepEqual(commandFrom(parseArgs(['rename-room', 'Research', 'Room', '--room', 'Core Room'])), {
    action: 'rename_room', room: 'Core Room', name: 'Research Room'
  });
  assert.deepEqual(commandFrom(parseArgs([
    'configure-room', '--room', 'Research Room', '--max-turns', '20',
    '--context-messages', '10', '--auto-relay', 'false', '--user-name', 'Drift'
  ])), {
    action: 'configure_room', room: 'Research Room', maxTurns: '20',
    contextMessages: '10', autoRelay: false, userName: 'Drift'
  });
  assert.deepEqual(commandFrom(parseArgs([
    'rename-agent', '--room', 'Research Room', '--member', 'agent-wren', '--name', 'Wren'
  ])), {
    action: 'rename_agent', room: 'Research Room', member: 'agent-wren', name: 'Wren'
  });
  assert.deepEqual(commandFrom(parseArgs([
    'set-agent-relay', 'off', '--room', 'Research Room', '--member', 'agent-astro'
  ])), {
    action: 'set_agent_relay', room: 'Research Room', member: 'agent-astro', enabled: false
  });
  assert.deepEqual(commandFrom(parseArgs([
    'remove-agent', '--room', 'Research Room', '--member', 'agent-old'
  ])), {
    action: 'remove_agent', room: 'Research Room', member: 'agent-old'
  });
});

test('dexctl exposes bound-agent relay stop and continue controls', () => {
  assert.deepEqual(commandFrom(parseArgs(['stop-relay', '--room', 'Core Room'])), {
    action: 'stop_relay', room: 'Core Room'
  });
  assert.deepEqual(commandFrom(parseArgs(['continue-relay', '--room', 'Core Room', '--turns', '6'])), {
    action: 'continue_relay', room: 'Core Room', turns: '6'
  });
});


test('dexctl exposes provider-neutral durable checkpoint commands', () => {
  assert.deepEqual(commandFrom(parseArgs([
    'checkpoint', 'Goal:', 'stabilize', 'Dex.', 'Next:', 'move', 'scheduler', 'server-side.', '--room', 'Core Room'
  ])), {
    action: 'checkpoint',
    note: 'Goal: stabilize Dex. Next: move scheduler server-side.',
    room: 'Core Room'
  });
  assert.deepEqual(commandFrom(parseArgs(['read-checkpoint', '--room', 'Core Room'])), {
    action: 'read_checkpoint',
    room: 'Core Room'
  });
  assert.throws(() => commandFrom(parseArgs(['checkpoint'])), /requires note text/);
});
