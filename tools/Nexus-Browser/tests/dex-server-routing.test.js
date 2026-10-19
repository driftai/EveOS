const test = require('node:test');
const assert = require('node:assert/strict');
const { createDexServerRouting } = require('../dex/server-routing.js');

function peer(kind) {
  return { clientKind: kind, sent: [] };
}

function setup() {
  const browser = peer('browser');
  const dex = peer('dex');
  const consolePeer = peer('console');
  const uiSockets = new Set([browser, dex, consolePeer]);
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  return { browser, dex, consolePeer, router: createDexServerRouting({ uiSockets, safeSend }) };
}

test('Dex request-id events are isolated from ordinary Base Mode browser clients', () => {
  const { browser, dex, consolePeer, router } = setup();
  router.broadcastExtensionEvent({ type: 'response_final', requestId: 'dex-room-turn', text: 'hello' });
  assert.equal(browser.sent.length, 0);
  assert.equal(consolePeer.sent.length, 0);
  assert.equal(dex.sent.length, 1);
});

test('ordinary extension events still broadcast to all UI peers', () => {
  const { browser, dex, consolePeer, router } = setup();
  router.broadcastExtensionEvent({ type: 'tabs_update', tabs: [] });
  assert.equal(browser.sent.length, 1);
  assert.equal(dex.sent.length, 1);
  assert.equal(consolePeer.sent.length, 1);
});

test('Dex-owned online target selection acknowledgement stays out of Base Mode transcript', () => {
  const { browser, dex, router } = setup();
  router.noteUiCommand(dex, { type: 'select_target', tabId: 42 });
  router.broadcastExtensionEvent({ type: 'target_selected', target: { id: 42, providerId: 'chatgpt' } });
  assert.equal(browser.sent.length, 0);
  assert.equal(dex.sent.length, 1);
});

test('local Dex traffic can still mirror to console peers but not ordinary browser peers', () => {
  const { browser, dex, consolePeer, router } = setup();
  assert.equal(router.allowLocalPeer(dex, browser), false);
  assert.equal(router.allowLocalPeer(dex, consolePeer), true);
  assert.equal(router.allowLocalPeer(browser, dex), true);
});


test('localhost routes Dex request events to one primary runtime only', () => {
  const primary = peer('dex');
  const standby = peer('dex');
  const uiSockets = new Set([primary, standby]);
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  const router = createDexServerRouting({ uiSockets, safeSend });
  assert.equal(router.registerDex(primary), true);
  assert.equal(router.registerDex(standby), false);
  router.broadcastExtensionEvent({ type: 'response_final', requestId: 'dex-one', text: 'hello' });
  assert.equal(primary.sent.filter((item) => item.type === 'response_final').length, 1);
  assert.equal(standby.sent.filter((item) => item.type === 'response_final').length, 0);
  assert.equal(router.isPrimaryDex(primary), true);
  assert.equal(router.isPrimaryDex(standby), false);
});

test('standby Dex runtime is promoted when primary disconnects', () => {
  const primary = peer('dex');
  const standby = peer('dex');
  const uiSockets = new Set([primary, standby]);
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  const router = createDexServerRouting({ uiSockets, safeSend });
  router.registerDex(primary);
  router.registerDex(standby);
  uiSockets.delete(primary);
  assert.equal(router.unregisterDex(primary), true);
  assert.equal(router.isPrimaryDex(standby), true);
  assert.equal(standby.sent.at(-1).type, 'dex_runtime_role');
  assert.equal(standby.sent.at(-1).role, 'primary');
});

test('explicit Human Input claim atomically transfers the sole primary editor', () => {
  const primary = peer('dex'), standby = peer('dex');
  const uiSockets = new Set([primary, standby]);
  const safeSend = (ws, payload) => { ws.sent.push(payload); return true; };
  const router = createDexServerRouting({ uiSockets, safeSend });
  router.registerDex(primary); router.registerDex(standby);
  assert.equal(router.claimPrimaryDex(standby), true);
  assert.equal(router.isPrimaryDex(primary), false);
  assert.equal(router.isPrimaryDex(standby), true);
  assert.deepEqual(primary.sent.at(-1), { type: 'dex_runtime_role', role: 'standby' });
  assert.deepEqual(standby.sent.at(-1), { type: 'dex_runtime_role', role: 'primary' });
});
