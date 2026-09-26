'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServerStreamNudgeAuth } = require('../dex/server-stream-nudge-auth');
const { createStreamNudgeController } = require('../extension/content/chatgpt-stream-nudge');
const { createStreamNudgeBridge } = require('../extension/chatgpt-stream-nudge-bridge');
const pageState = require('../extension/content/chatgpt-page-state');
const root = path.resolve(__dirname, '..');
const url = 'https://chatgpt.com/g/g-example/c/conversation-id?model=auto';
const source = { targetClassId: 'online-origin', providerId: 'chatgpt', targetId: 42, url };
const marker = { type: 'nexus_chatgpt_stream_error', reason: 'CHATGPT_MESSAGE_STREAM_ERROR',
  turnKey: 'native-user-9-1234567890' };
function state() {
  return { rooms: [
    { id: 'other', name: 'Other', members: [
      { id: 'other-agent', binding: { targetClassId: 'online-origin', targetId: 5,
        url: 'https://chatgpt.com/c/another', providerId: 'chatgpt' } }
    ], relay: { active: false } },
    { id: 'eve-astro', name: 'Eve + Astro', members: [
      { id: 'eve', binding: { ...source } },
      { id: 'astro', binding: { targetClassId: 'local-origin',
        targetId: 'local:antigravity-existing:99', providerId: 'local-antigravity-existing' } }
    ], relay: { active: false } }
  ] };
}
function auth(snapshot = state(), ready = true) {
  return createServerStreamNudgeAuth({
    getState: () => snapshot, getTabs: () => [{ id: 42, providerId: 'chatgpt', url }],
    extensionReady: () => ready
  });
}
test('any exact bound ChatGPT conversation (including GPT URLs) is eligible in an idle room', () => {
  const grant = auth().check({ source, reason: marker.reason, turnKey: marker.turnKey });
  assert.equal(grant.ok, true);
  assert.deepEqual(grant.roomIds, ['eve-astro']);
  const homepage = 'https://chatgpt.com/';
  const room = state();
  room.rooms[1].members[0].binding.url = homepage;
  const gate = createServerStreamNudgeAuth({
    getState: () => room, getTabs: () => [{ id: 42, providerId: 'chatgpt', url: homepage }],
    extensionReady: () => true
  });
  assert.equal(gate.check({ source: { ...source, url: homepage },
    reason: marker.reason, turnKey: marker.turnKey }).ok, true);
});
test('all durable rooms are consulted; wrong tab, provider, changed chat and unbound URLs fail closed', () => {
  const gate = auth();
  const request = { source, reason: marker.reason, turnKey: marker.turnKey };
  assert.equal(gate.check({ ...request, source: { ...source, targetId: 50 } }).ok, false);
  assert.equal(gate.check({ ...request, source: { ...source, url: 'https://chatgpt.com/c/unbound' } }).ok, false);
  assert.equal(gate.check({ ...request, source: { ...source, url: 'https://chatgpt.com.evil/c/one' } }).ok, false);
  assert.equal(gate.check({ ...request, source: { ...source, providerId: 'muse' } }).ok, false);
  assert.equal(auth(state(), false).check(request).retryable, true);
});
test('busy room, recovering original turn and active maintenance defer without injecting', () => {
  const snapshot = state(), input = { source, reason: marker.reason, turnKey: marker.turnKey };
  snapshot.rooms[1].relay.active = true;
  assert.equal(auth(snapshot).check(input).code, 'STREAM_NUDGE_DEX_TURN_BUSY');
  snapshot.rooms[1].relay.active = false; snapshot.rooms[1].recovery = { requestId: 'old' };
  assert.equal(auth(snapshot).check(input).retryable, true);
  delete snapshot.rooms[1].recovery;
  const gate = createServerStreamNudgeAuth({ getState: () => snapshot,
    getTabs: () => [{ id: 42, providerId: 'chatgpt', url }],
    extensionReady: () => true, maintenanceBusy: () => true });
  assert.equal(gate.check(input).code, 'STREAM_NUDGE_MAINTENANCE_BUSY');
});
test('native first-turn and active Dex watcher each emit one error reason without replaying a prompt', () => {
  let time = 1000, user = {}, generating = false, issue = null;
  const events = [], answer = { userNodes: () => [user] };
  const controller = createStreamNudgeController({
    pageState: { issueSnapshot: () => new Map(),
      findChangedIssue: () => issue }, answer,
    input: { generationLooksActive: () => generating },
    getRuntime: () => ({ responsePending: () => true }),
    send: (payload) => { events.push(payload); return Promise.resolve({ ok: true }); },
    now: () => time
  });
  user = {}; issue = { code: 'CHATGPT_MESSAGE_STREAM_ERROR' };
  controller.sample();
  time += 1800;
  assert.equal(controller.sample(), true, 'Dex watcher must not block an observed provider failure');
  assert.equal(events.length, 1);
  assert.equal(controller.reportDexError('dex-turn-abcdef123456'), false, 'same turn cannot nudge twice');
  assert.equal(events[0].reason, marker.reason);
  assert.equal(Object.hasOwn(events[0], 'text'), false);
  controller.suppressFor();
  user = {}; time += 100;
  controller.sample();
  time += 2000;
  assert.equal(controller.sample(), false, 'a recovery prompt cannot trigger another nudge');
  const direct = createStreamNudgeController({
    pageState: { issueSnapshot: () => new Map(), findChangedIssue: () => null }, answer,
    input: { generationLooksActive: () => false },
    send: (payload) => events.push(payload), now: () => time
  });
  assert.equal(direct.reportDexError('dex-turn-0000deadbeef'), true);
  assert.equal(events.length, 2);
});
test('an assistant mentioning the error is not mistaken for provider UI', () => {
  let time = 1000, user = {};
  const events = [];
  const issue = { code: 'CHATGPT_MESSAGE_STREAM_ERROR', element: {
    closest: (selector) => selector.includes('markdown') ? {} : null
  } };
  const controller = createStreamNudgeController({
    pageState: { issueSnapshot: () => new Map(), findChangedIssue: () => issue },
    answer: { userNodes: () => [user] },
    input: { generationLooksActive: () => false },
    send: (event) => events.push(event), now: () => time
  });
  user = {}; controller.sample(); time += 3000; controller.sample();
  assert.equal(events.length, 0);
  assert.equal(pageState.classifyIssueText('Error in message stream').code,
    'CHATGPT_MESSAGE_STREAM_ERROR');
  assert.equal(pageState.classifyIssueText('The user said Error in message stream'), null);
});
function harness(authorization = async () => ({ ok: true, authorized: true, roomIds: ['eve-astro'] }),
  acknowledge = true) {
  const records = new Map(), sends = [], authRequests = [];
  const api = {
    runtime: { id: 'nexus-local-test' },
    storage: { local: {
      get: async (key) => ({ [key]: records.get(key) }),
      set: async (obj) => { for (const [key, val] of Object.entries(obj)) records.set(key, val); }
    } },
    tabs: {
      get: async (id) => ({ id, url }),
      sendMessage: async (id, message) => {
        sends.push({ id, message }); return { ok: acknowledge };
      }
    }
  };
  const bridge = createStreamNudgeBridge({
    chromeApi: api, freshness: { ensure: async () => {} },
    authorize: async (...args) => { authRequests.push(args); return authorization(...args); },
    now: () => 10000, wait: async () => {}
  });
  return { bridge, records, sends, authRequests, sender: {
    id: 'nexus-local-test', tab: { id: 42, url } } };
}
test('only an exact room authorization can inject a new continuation prompt', async () => {
  const h = harness();
  assert.equal(await h.bridge.handle(marker, h.sender), true);
  assert.equal(h.sends.length, 2, 'one loop suppression and one prompt, no Dex relay');
  assert.equal(h.sends[1].message.delivery.kind, 'dex-stream-nudge');
  assert.equal(h.sends[1].message.delivery.turnKey, marker.turnKey);
  assert.match(h.sends[1].message.text, /HEADSUP/);
  assert.equal(h.authRequests.length, 2, 'recheck after adapter hydration');
  assert.equal(h.records.get('nexus-stream-nudge:42').state, 'submitted');
  assert.equal(await h.bridge.handle(marker, h.sender), false);
  assert.equal(h.sends.length, 2, 'persistent claim suppresses duplicate prompt');
  assert.equal(await h.bridge.handleOutcome({ type: 'nexus_stream_nudge_reply_result',
    turnKey: marker.turnKey, ok: true }, h.sender), true);
  assert.equal(h.records.get('nexus-stream-nudge:42').state, 'reply-completed');
});
test('unbound tabs never receive a nudge; busy rooms are rechecked but never cause task replay', async () => {
  const unbound = harness(async () => ({ ok: false, code: 'STREAM_NUDGE_NO_DEX_MEMBERSHIP' }));
  assert.equal(await unbound.bridge.handle(marker, unbound.sender), false);
  assert.equal(unbound.sends.length, 0);
  let attempts = 0;
  const deferred = harness(async () => (++attempts < 3
    ? { ok: false, retryable: true, code: 'STREAM_NUDGE_DEX_TURN_BUSY' }
    : { ok: true, authorized: true, roomIds: ['eve-astro'] }));
  assert.equal(await deferred.bridge.handle(marker, deferred.sender), true);
  assert.equal(attempts, 4);
  assert.equal(deferred.sends.filter((x) => x.message.type === 'send_prompt').length, 1);
});
test('negative/uncertain browser acknowledgement remains claimed across service-worker restart', async () => {
  const h = harness(undefined, false);
  assert.equal(await h.bridge.handle(marker, h.sender), false);
  assert.equal(h.records.get('nexus-stream-nudge:42').state, 'claimed');
  assert.equal(await h.bridge.handle(marker, h.sender), false);
  assert.equal(h.sends.length, 1, 'suppression failed: never risk submitting a prompt');
  const wrong = { ...h.sender, tab: { id: 42, url: 'https://chatgpt.com/c/other' } };
  assert.equal(await h.bridge.handle(marker, wrong), false);
});
test('static integration registers both scripts after main ChatGPT adapter and authority bridge', () => {
  const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
  const manifest = JSON.parse(read('extension/manifest.json'));
  const group = manifest.content_scripts.find((x) => x.matches.includes('https://chatgpt.com/*'));
  assert.ok(group.js.indexOf('content/chatgpt-stream-nudge.js') > group.js.indexOf('content/chatgpt.js'));
  const worker = read('extension/service-worker-entry.js');
  assert.ok(worker.indexOf('dex-provider-control-bridge.js') < worker.indexOf('chatgpt-stream-nudge-bridge.js'));
  assert.match(read('server.js'), /await streamNudgeAuth\.handle\(ws, msg, safeSend\)/);
  assert.match(read('public/dex-failure-policy.js'), /CHATGPT_STREAM_CACHE_EXPIRED: \{ action: 'recover'/);
  assert.match(read('extension/dex-provider-control-bridge.js'), /authorizeStreamNudge/);
  assert.equal(require('../extension/content/provider-adapter-revision').ADAPTER_REVISION, 47);
});

test('both native stream errors authorize on the exact bound chat; malformed dex key is denied', () => {
  for (const reason of ['CHATGPT_MESSAGE_STREAM_ERROR', 'CHATGPT_STREAM_CACHE_EXPIRED']) {
    assert.equal(auth().check({ source, reason, turnKey: 'dex-dex-turn-deadbeef00000000' }).ok, true);
  }
  assert.equal(auth().check({ source, reason: 'PROVIDER_RATE_LIMITED',
    turnKey: 'native-user-9-1234567890' }).ok, false);
  assert.equal(pageState.classifyIssueText('Stream cache expired')?.code, 'CHATGPT_STREAM_CACHE_EXPIRED');
  assert.equal(pageState.classifyIssueText('I said Stream cache expired'), null);
  assert.equal(pageState.trustedStreamIssue({ code: 'CHATGPT_STREAM_CACHE_EXPIRED', element: {
    closest: (selector) => selector.includes('markdown') ? {} : null
  } }), false, 'quoted ChatGPT prose must not be treated as provider failure');
  assert.equal(pageState.trustedStreamIssue({ code: 'CHATGPT_STREAM_CACHE_EXPIRED', element: {
    closest: (selector) => selector.includes('role="alert"') ? {} : null
  } }), true);
});
test('expired stream cache sends the second reason, exact-tab continuation and one persistent claim', async () => {
  let clock = 1000, user = {}, issue = null;
  const events = [];
  const controller = createStreamNudgeController({
    pageState: { issueSnapshot: () => new Map(), findChangedIssue: () => issue },
    answer: { userNodes: () => [user] },
    input: { generationLooksActive: () => false },
    now: () => clock, send: (payload) => events.push(payload)
  });
  user = {}; issue = { code: 'CHATGPT_STREAM_CACHE_EXPIRED' };
  controller.sample(); clock += 1800; assert.equal(controller.sample(), true);
  assert.equal(events[0].reason, 'CHATGPT_STREAM_CACHE_EXPIRED');
  const h = harness();
  assert.equal(await h.bridge.handle(events[0], h.sender), true);
  assert.match(h.sends[1].message.text, /Stream cache expired/);
  assert.equal(await h.bridge.handle(events[0], h.sender), false);
  assert.equal(h.sends.filter((event) => event.message.type === 'send_prompt').length, 1);
  assert.equal(h.authRequests[0][2], 'CHATGPT_STREAM_CACHE_EXPIRED');
});

test('a URL-only room binding cannot silently authorize one of two duplicate ChatGPT tabs', () => {
  const snapshot = state();
  snapshot.rooms[1].members[0].binding = {
    targetClassId: 'online-origin', providerId: 'chatgpt', url
  };
  const gate = createServerStreamNudgeAuth({
    getState: () => snapshot,
    getTabs: () => [{ id: 42, providerId: 'chatgpt', url }, { id: 84, providerId: 'chatgpt', url }],
    extensionReady: () => true
  });
  const result = gate.check({ source, reason: marker.reason, turnKey: marker.turnKey });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STREAM_NUDGE_NO_DEX_MEMBERSHIP');
  snapshot.rooms[1].members[0].binding.targetId = 42;
  assert.equal(gate.check({ source, reason: marker.reason, turnKey: marker.turnKey }).ok, true);
});

test('active Dex provider stream failure parks the original turn for one correlated continuation final', async () => {
  const failure = require('../public/dex-failure-policy');
  for (const code of ['CHATGPT_MESSAGE_STREAM_ERROR', 'CHATGPT_STREAM_CACHE_EXPIRED'])
    assert.equal(failure.decision(code, { dispatched: true }).action, 'recover');
  const snapshot = state();
  snapshot.rooms[1].recovery = {
    requestId: 'dex-turn-0000abcd1234', memberId: 'eve',
    streamNudge: { reason: 'CHATGPT_STREAM_CACHE_EXPIRED',
      deadlineAt: new Date(Date.now() + 45000).toISOString() }
  };
  const reconciled = [];
  const gate = createServerStreamNudgeAuth({
    getState: () => snapshot, getTabs: () => [{ id: 42, providerId: 'chatgpt', url }],
    extensionReady: () => true, reconcileFinal: async (event) => { reconciled.push(event); return true; }
  });
  const input = { source, reason: 'CHATGPT_STREAM_CACHE_EXPIRED',
    turnKey: 'dex-dex-turn-0000abcd1234' };
  assert.equal(gate.check(input).ok, true, 'the exact parked recovery may receive a continuation');
  const result = await gate.final({ type: 'dex_stream_nudge_final', ...input,
    originalRequestId: 'dex-turn-0000abcd1234', text: 'Recovered final response.' });
  assert.equal(result.ok, true);
  assert.equal(reconciled.length, 1);
  assert.deepEqual(reconciled[0], {
    type: 'response_final', requestId: 'dex-turn-0000abcd1234',
    text: 'Recovered final response.', observedAt: reconciled[0].observedAt,
    detail: { via: 'dex-stream-nudge', reason: 'CHATGPT_STREAM_CACHE_EXPIRED' }
  });
  assert.equal((await gate.final({ type: 'dex_stream_nudge_final', ...input,
    originalRequestId: 'dex-turn-WRONG0000', text: 'duplicate' })).ok, false);
});
