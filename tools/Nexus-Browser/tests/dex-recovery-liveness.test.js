'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerSchedulerRecovery, MAX_RECOVERY_MS } = require('../dex/server-scheduler-recovery');
const { createDexServerScheduler } = require('../dex/server-scheduler');
const { PASSIVE_GRACE_MS } = require('../dex/passive-recovery-lifecycle');
const { remainingMs } = require('../dex/recovery-liveness');

function rig({ local = false, offline = false, badTimestamp = false } = {}) {
  let stamp = Date.parse('2026-09-25T23:00:00.000Z');
  const now = () => new Date(stamp).toISOString();
  const target = local
    ? { id: 'local:antigravity-existing:9', providerId: 'local-antigravity-existing' }
    : { id: 42, providerId: 'chatgpt', url: 'https://chatgpt.com/c/eve' };
  let state = { rooms: [{
    id: 'room-1', name: 'Eve and Astro', members: [
      { id: 'eve', name: 'Eve', binding: {
        targetClassId: local ? 'local-origin' : 'online-origin',
        providerId: target.providerId, targetId: target.id, url: target.url || ''
      } }
    ], messages: [{ id: 'source', senderKind: 'user', text: 'Prior turn' }],
    relay: { active: false, remaining: 0, waitingFor: null },
    recovery: { requestId: 'dex-turn-stalled', memberId: 'eve', sourceMessageId: 'source',
      targetClassId: local ? 'local-origin' : 'online-origin',
      providerId: target.providerId, dispatched: true,
      startedAt: badTimestamp ? 'invalid-time' : now(),
      interruptedAt: badTimestamp ? 'invalid-time' : now() }
  }] };
  const saved = [], scheduled = [], sent = [], incidents = [];
  const load = () => structuredClone(state);
  const save = (next) => { state = structuredClone(next); saved.push(state); return load(); };
  const durability = {
    query: () => ({ reliable: true, entry: { state: 'accepted' } }),
    markFailed: async () => {}, beforeDispatch: async () => ({ ok: true }),
    observe: async () => {}
  };
  let beganCapture;
  const captureStarted = new Promise(resolve => { beganCapture = resolve; });
  let settleCapture;
  const waitingCapture = new Promise(resolve => { settleCapture = resolve; });
  const args = {
    load, save, uid: prefix => prefix + '-x', nowMs: () => stamp,
    getOnlineTargets: () => local ? [] : [target],
    getSelectedOnlineTarget: () => local ? null : target,
    getLocalTargets: async () => local ? [target] : [],
    getProviders: () => [{
      id: target.providerId,
      adapterContract: { operations: { recover: true, captureLatest: true, send: true } }
    }],
    isExtensionAvailable: () => !offline,
    sendExtension: msg => { sent.push(msg); return true; },
    captureLocalLatest: async () => { beganCapture(); return waitingCapture; },
    addMessage: (room, input) => {
      const entry = { id: 'recovered-' + room.messages.length, ...input };
      room.messages.push(entry); return entry;
    },
    enqueueNext: () => {},
    setStopped: (room, reason) => { delete room.recovery; room.relay.lastStopReason = reason; },
    recordIncident: item => incidents.push(item),
    markTimedOut: async () => {},
    processSoon: ms => scheduled.push(ms)
  };
  return {
    args, durability, captureStarted,
    finishCapture: result => settleCapture(result),
    advance: ms => { stamp += ms; },
    get state() { return state; }, get scheduled() { return scheduled; },
    get incidents() { return incidents; }, get sent() { return sent; },
    now, load, save
  };
}

test('active capture that never replies expires on its independently scheduled deadline', async () => {
  const h = rig();
  const recovery = createServerSchedulerRecovery(h.args);
  await recovery.resume(h.durability);
  assert.equal(h.sent.filter(msg => msg.type === 'capture_latest').length, 1);
  assert.ok(h.scheduled.some(ms => ms >= MAX_RECOVERY_MS));
  h.advance(MAX_RECOVERY_MS + 2);
  await recovery.resume(h.durability);
  assert.equal(recovery.diagnostics().active, null);
  assert.ok(h.state.rooms[0].recovery.passiveAt);
  assert.equal(h.sent.filter(msg => msg.type === 'send_prompt').length, 0);
  assert.equal(h.incidents.filter(item => item.code === 'RECOVERY_TIMEOUT').length, 1);
  await recovery.resume(h.durability);
  assert.equal(h.incidents.filter(item => item.code === 'RECOVERY_TIMEOUT').length, 1);
});

test('an offline extension still ages out its recovery without needing a reconnect', async () => {
  const h = rig({ offline: true });
  const recovery = createServerSchedulerRecovery(h.args);
  await recovery.resume(h.durability);
  assert.equal(recovery.diagnostics().active, null);
  assert.ok(h.scheduled.some(ms => ms >= MAX_RECOVERY_MS));
  h.advance(MAX_RECOVERY_MS + 2);
  await recovery.resume(h.durability);
  assert.ok(h.state.rooms[0].recovery.passiveAt);
  assert.equal(h.sent.length, 0);
});

test('corrupt recovery timestamps fail closed instead of pinning a room permanently', async () => {
  const h = rig({ badTimestamp: true });
  const recovery = createServerSchedulerRecovery(h.args);
  await recovery.resume(h.durability);
  assert.ok(h.state.rooms[0].recovery.passiveAt);
  assert.ok(h.scheduled.includes(PASSIVE_GRACE_MS));
  assert.equal(h.incidents.filter(item => item.code === 'RECOVERY_INVALID_TIMESTAMP').length, 1);
  assert.equal(h.sent.filter(msg => msg.type === 'send_prompt').length, 0);
  assert.equal(remainingMs({ startedAt: 'bad-time' }, Date.now(), MAX_RECOVERY_MS), null);
});

test('late completion of the old local capture cannot commit or clear a newer worker', async () => {
  const h = rig({ local: true });
  const recovery = createServerSchedulerRecovery(h.args);
  const pending = recovery.resume(h.durability);
  await h.captureStarted;
  assert.ok(h.scheduled.some(ms => ms >= MAX_RECOVERY_MS));
  h.advance(MAX_RECOVERY_MS + 2);
  await recovery.resume(h.durability);
  assert.equal(recovery.diagnostics().active, null);
  h.finishCapture({ text: 'Late old result.', generationState: 'idle' });
  await pending;
  assert.equal(h.state.rooms[0].messages.length, 1);
  assert.ok(h.state.rooms[0].recovery.passiveAt);
  assert.equal(h.sent.filter(msg => msg.type === 'send_prompt').length, 0);
});

test('a hung local capture does not hold the scheduler processing lock beyond the deadline', async () => {
  const h = rig({ local: true });
  const scheduler = createDexServerScheduler({
    stateStore: { load: h.load, save: h.save }, durability: h.durability,
    getLocalTargets: h.args.getLocalTargets, getOnlineTargets: h.args.getOnlineTargets,
    getProviders: h.args.getProviders, getSelectedOnlineTarget: h.args.getSelectedOnlineTarget,
    isExtensionAvailable: h.args.isExtensionAvailable,
    sendExtension: h.args.sendExtension,
    sendLocalPrompt: async () => {},
    captureLocalLatest: h.args.captureLocalLatest,
    recordIncident: h.args.recordIncident,
    now: h.now, nowMs: h.args.nowMs,
    setTimer(fn, ms) { h.scheduled.push(ms); return { fn, ms }; },
    clearTimer() {}
  });
  await scheduler.process();
  await h.captureStarted;
  h.advance(MAX_RECOVERY_MS + 2);
  await scheduler.process();
  assert.ok(h.state.rooms[0].recovery.passiveAt);
  assert.equal(scheduler.diagnostics().recovery.active, null);
  h.finishCapture({ text: 'Late orphan.' });
  await Promise.resolve();
  assert.equal(h.state.rooms[0].messages.length, 1);
  h.advance(PASSIVE_GRACE_MS + 2);
  await scheduler.process();
  assert.equal(h.state.rooms[0].recovery, undefined);
  assert.equal(h.state.rooms[0].lateFinalWatches.length, 1);
});

test('invalid offline recovery is quarantined immediately, without hot-looping', async () => {
  const h = rig({ offline: true, badTimestamp: true });
  const recovery = createServerSchedulerRecovery(h.args);
  await recovery.resume(h.durability);
  assert.ok(h.state.rooms[0].recovery.passiveAt);
  assert.equal(h.incidents.filter(item => item.code === 'RECOVERY_INVALID_TIMESTAMP').length, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.scheduled.filter(ms => ms === 1).length, 0);
});
