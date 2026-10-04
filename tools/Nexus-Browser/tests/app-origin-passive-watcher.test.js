'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manager = require('../app-targets/manager');
const { createPassiveTurnLedger } = require('../app-targets/passive-turn-ledger');
const { createPassiveAppWatcher, deliveryFingerprint } = require('../app-targets/passive-watcher');

const fp = (char) => char.repeat(64);
const target = {
  id: 'app-chatgpt-windows',
  providerId: 'chatgpt-desktop',
  providerName: 'ChatGPT App',
  targetClassId: 'app-origin',
  pid: 118148,
  windowHandle: 4473474,
  concreteTargetIdentity: {
    kind: 'windows-app-window',
    processId: 118148,
    windowHandle: 4473474,
    conversationAnchor: fp('c'),
    conversationAnchors: [fp('a'), fp('b'), fp('c')]
  }
};
const oldTurn = { fingerprint: fp('1'), text: 'old native reply', partCount: 1, order: 0 };

function makeHarness({
  ledgerFile = null, initialTurns = [oldTurn], watchTarget = target,
  settleMs = 0, settleRecheckMs = 350
} = {}) {
  const dir = ledgerFile ? path.dirname(ledgerFile) : fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-app-watch-'));
  const filePath = ledgerFile || path.join(dir, 'seen.jsonl');
  const ledger = createPassiveTurnLedger({ filePath });
  let snapshot = {
    generating: false,
    identity: {
      conversationTitle: '',
      conversationAnchor: fp('c'),
      conversationAnchors: [fp('a'), fp('b'), fp('c')]
    },
    turns: initialTurns.map((turn) => ({ ...turn }))
  };
  let listener = null, clock = 1000;
  const events = [], rebinds = [];
  const adapter = {
    async captureLatest() {
      return { text: snapshot.turns.at(-1)?.text || '', snapshot, isGenerating: !!snapshot.generating };
    },
    completedTurns(value) { return value.turns.map((turn) => ({ ...turn })); },
    conversationIdentity(value) {
      return { ...value.identity, conversationAnchors: [...value.identity.conversationAnchors] };
    }
  };
  const appTargets = {
    adapterForTarget: () => adapter,
    exactAppTargetMatch: manager.exactAppTargetMatch,
    advanceAppTargetBinding: manager.advanceAppTargetBinding,
    appTargetBusy: () => false,
    onAppTurnFinal(fn) { listener = fn; return () => { if (listener === fn) listener = null; }; }
  };
  const watcher = createPassiveAppWatcher({
    appTargets,
    ledger,
    hasSubscribers: () => true,
    emit(payload) { events.push(payload); return 1; },
    onRebind(payload) { rebinds.push(payload); },
    setTimer: () => ({ fake: true }),
    clearTimer() {},
    intervalMs: 2000,
    idleMs: 6000,
    retryMs: 6000,
    settleMs,
    settleRecheckMs,
    now: () => clock
  });
  watcher.watch(watchTarget);
  return {
    watcher, ledger, events, rebinds, filePath, dir,
    snapshot: () => snapshot,
    setSnapshot(next) { snapshot = next; },
    advance(ms) { clock += ms; },
    fireObserved(event) { return listener?.(event); },
    cleanup() { watcher.stop(); if (!ledgerFile) fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('manual native reply is observed once and acknowledged exactly once', async () => {
  const h = makeHarness();
  try {
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 0, 'existing history must only seed the baseline');
    const next = { fingerprint: fp('2'), text: 'manual native reply', partCount: 1, order: 1 };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, next] });
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].text, 'manual native reply');
    assert.equal(await h.watcher.ack({ targetId: target.id, fingerprint: h.events[0].fingerprint }), true);
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 1, 'ACKed native turn must not be emitted again');
  } finally { h.cleanup(); }
});

test('active Nexus final shares passive dedupe identity and is not emitted twice', async () => {
  const h = makeHarness();
  try {
    await h.watcher.scanNow(target.id);
    const active = { fingerprint: fp('3'), text: 'active Nexus final', partCount: 1, order: 1 };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, active] });
    await h.fireObserved({ target, turn: active, source: 'active' });
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 0);
    assert.equal(h.ledger.entry(deliveryFingerprint(target, active.fingerprint))?.state, 'delivered');
  } finally { h.cleanup(); }
});

test('newly exposed historical turns before the cursor never replay after priming', async () => {
  const current = { fingerprint: fp('3'), text: 'current visible reply', partCount: 1, order: 1 };
  const h = makeHarness({ initialTurns: [oldTurn, current] });
  try {
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 0);

    const hiddenA = { fingerprint: fp('4'), text: 'older hidden answer A', partCount: 1, order: 1 };
    const hiddenB = { fingerprint: fp('5'), text: 'older hidden answer B', partCount: 1, order: 2 };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, hiddenA, hiddenB, current] });
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 0, 'historical turns inserted before cursor must stay baseline-only');

    const fresh = { fingerprint: fp('6'), text: 'genuinely new passive answer', partCount: 1, order: 4 };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, hiddenA, hiddenB, current, fresh] });
    await h.watcher.scanNow(target.id);
    assert.deepEqual(h.events.map((event) => event.text), [fresh.text]);
  } finally { h.cleanup(); }
});

test('passive watcher waits for a short native turn to stabilize before emitting it', async () => {
  const h = makeHarness({ settleMs: 900, settleRecheckMs: 350 });
  try {
    await h.watcher.scanNow(target.id);
    const partial = { fingerprint: fp('a'), text: 'STABILITY_\n\nPASSI', partCount: 2, order: 1 };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, partial] });
    h.advance(100);
    let result = await h.watcher.scanNow(target.id);
    assert.equal(result.settling, true);
    assert.equal(h.events.length, 0);

    const complete = { fingerprint: fp('b'), text: 'STABILITY_PASSIVE_OK', partCount: 1, order: 1 };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, complete] });
    h.advance(350);
    result = await h.watcher.scanNow(target.id);
    assert.equal(result.settling, true);
    assert.equal(h.events.length, 0, 'a growing passive reply must reset the settle window');

    h.advance(950);
    result = await h.watcher.scanNow(target.id);
    assert.equal(result.settled, true);
    assert.deepEqual(h.events.map((event) => event.text), ['STABILITY_PASSIVE_OK']);
  } finally { h.cleanup(); }
});

test('restart with unchanged native conversation emits no historical turns', async () => {
  const first = makeHarness();
  const filePath = first.filePath;
  try {
    await first.watcher.scanNow(target.id);
    first.watcher.stop();
    const second = makeHarness({ ledgerFile: filePath });
    try {
      await second.watcher.scanNow(target.id);
      assert.equal(second.events.length, 0);
    } finally { second.watcher.stop(); }
  } finally { fs.rmSync(first.dir, { recursive: true, force: true }); }
});

test('one genuinely new reply that arrived across restart is emitted once', async () => {
  const first = makeHarness();
  const filePath = first.filePath;
  try {
    await first.watcher.scanNow(target.id);
    first.watcher.stop();
    const late = { fingerprint: fp('4'), text: 'reply completed while Nexus was down', partCount: 1, order: 1 };
    const second = makeHarness({ ledgerFile: filePath, initialTurns: [oldTurn, late] });
    try {
      await second.watcher.scanNow(target.id);
      assert.deepEqual(second.events.map((event) => event.text), [late.text]);
    } finally { second.watcher.stop(); }
  } finally { fs.rmSync(first.dir, { recursive: true, force: true }); }
});

test('fresh manual delivery scope baselines visible history instead of replaying an old unseen turn', async () => {
  const firstTarget = {
    ...target,
    concreteTargetIdentity: { ...target.concreteTargetIdentity, deliveryScope: fp('d') }
  };
  const first = makeHarness({ watchTarget: firstTarget });
  const filePath = first.filePath;
  try {
    await first.watcher.scanNow(firstTarget.id);
    first.watcher.stop();
    const historical = { fingerprint: fp('4'), text: 'already visible before manual reconnect', partCount: 1, order: 1 };
    const rebound = {
      ...target,
      concreteTargetIdentity: { ...target.concreteTargetIdentity, deliveryScope: fp('e') }
    };
    const second = makeHarness({ ledgerFile: filePath, initialTurns: [oldTurn, historical], watchTarget: rebound });
    try {
      const result = await second.watcher.scanNow(rebound.id);
      assert.equal(result.primed, true);
      assert.equal(second.events.length, 0);
      assert.equal(second.ledger.cursor(fp('e'))?.nativeFingerprint, historical.fingerprint);
    } finally { second.watcher.stop(); }
  } finally { fs.rmSync(first.dir, { recursive: true, force: true }); }
});

test('rolling virtualized anchor windows stay bound across later native turns', async () => {
  const h = makeHarness();
  try {
    await h.watcher.scanNow(target.id);
    for (const identity of [
      { conversationTitle: '', conversationAnchor: fp('d'), conversationAnchors: [fp('b'), fp('c'), fp('d')] },
      { conversationTitle: '', conversationAnchor: fp('e'), conversationAnchors: [fp('c'), fp('d'), fp('e')] },
      { conversationTitle: '', conversationAnchor: fp('1'), conversationAnchors: [fp('d'), fp('e'), fp('1')] }
    ]) {
      h.setSnapshot({ ...h.snapshot(), identity });
      const result = await h.watcher.scanNow(target.id);
      assert.equal(result.code, undefined);
    }
    assert.equal(h.rebinds.length, 0);
  } finally { h.cleanup(); }
});

test('active final keeps the binding across ChatGPT title and anchor rotation', async () => {
  const h = makeHarness();
  try {
    await h.watcher.scanNow(target.id);
    const active = { fingerprint: fp('6'), text: 'active final after a long tool turn', partCount: 1, order: 1 };
    await h.fireObserved({ target, turn: active, source: 'active' });
    h.setSnapshot({
      generating: false,
      identity: {
        conversationTitle: 'Auto-renamed after response',
        conversationAnchor: fp('f'),
        conversationAnchors: [fp('f')]
      },
      turns: [active]
    });
    const result = await h.watcher.scanNow(target.id);
    assert.equal(result.code, undefined);
    assert.equal(h.rebinds.length, 0);
  } finally { h.cleanup(); }
});

test('native conversation switch fails closed and requires rebind', async () => {
  const h = makeHarness();
  try {
    await h.watcher.scanNow(target.id);
    h.setSnapshot({
      generating: false,
      identity: { conversationTitle: 'Different chat', conversationAnchor: fp('f'), conversationAnchors: [fp('f')] },
      turns: [{ fingerprint: fp('5'), text: 'wrong conversation reply', partCount: 1, order: 0 }]
    });
    const result = await h.watcher.scanNow(target.id);
    assert.equal(result.code, 'APP_TARGET_REBIND_REQUIRED');
    assert.equal(h.events.length, 0);
    assert.equal(h.rebinds.length, 1);
  } finally { h.cleanup(); }
});

test('passive native event preserves the complete reconstructed multi-node answer', async () => {
  const h = makeHarness();
  try {
    await h.watcher.scanNow(target.id);
    const text = 'ALPHA first paragraph.\n\nBETA second paragraph.\n\n- THREE list item';
    const longTurn = { fingerprint: fp('6'), text, partCount: 3, order: 1 };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, longTurn] });
    await h.watcher.scanNow(target.id);
    assert.equal(h.events[0].text, text);
  } finally { h.cleanup(); }
});

test('multiple rapid completed native turns remain ordered and exactly once', async () => {
  const h = makeHarness();
  try {
    await h.watcher.scanNow(target.id);
    const rapid = [
      { fingerprint: fp('7'), text: 'first rapid reply', partCount: 1, order: 1 },
      { fingerprint: fp('8'), text: 'second rapid reply', partCount: 1, order: 2 },
      { fingerprint: fp('9'), text: 'third rapid reply', partCount: 1, order: 3 }
    ];
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, ...rapid] });
    await h.watcher.scanNow(target.id);
    assert.deepEqual(h.events.map((event) => event.text), rapid.map((turn) => turn.text));
    for (const event of h.events) {
      await h.watcher.ack({ targetId: target.id, fingerprint: event.fingerprint });
    }
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 3);
  } finally { h.cleanup(); }
});


test('role-owned passive turns wait for completeHint before delivery', async () => {
  const h = makeHarness();
  try {
    await h.watcher.scanNow(target.id);
    const partialA = { fingerprint: fp('a'), text: 'At this point I would stop poking', partCount: 1, order: 1, completeHint: false };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, partialA] });
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 0);

    const partialB = { fingerprint: fp('b'), text: 'At this point I would stop poking the transport and start', partCount: 1, order: 1, completeHint: false };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, partialB] });
    await h.watcher.scanNow(target.id);
    assert.equal(h.events.length, 0);

    const final = { fingerprint: fp('c'), text: 'At this point I would stop poking the transport and start using Nexus normally.', partCount: 1, order: 1, completeHint: true };
    h.setSnapshot({ ...h.snapshot(), turns: [oldTurn, final] });
    await h.watcher.scanNow(target.id);
    assert.deepEqual(h.events.map((event) => event.text), [final.text]);
  } finally { h.cleanup(); }
});
