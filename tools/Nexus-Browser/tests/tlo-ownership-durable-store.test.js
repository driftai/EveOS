'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTloOwnershipFence } = require('../dex/tlo-ownership-fence');
const { createDurableTloOwnershipStore, STORE_SCHEMA } = require('../dex/tlo-ownership-durable-store');

function fixture(t) {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-tlo-cas-'));
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  const first = createDurableTloOwnershipStore({ dirPath });
  return { dirPath, first, fence: createTloOwnershipFence(first) };
}
const owner = (id = 'search-monitor-browser-01', generation = 1) => ({ kind: 'browser', id, generation });

test('importing the CAS module has no runtime files or inference side effects', () => {
  assert.equal(typeof createDurableTloOwnershipStore, 'function');
  assert.equal(typeof STORE_SCHEMA, 'string');
});
test('reads missing scope as unclaimed without creating any files', (t) => {
  const { dirPath, first } = fixture(t);
  assert.equal(first.read('default'), null);
  assert.deepEqual(fs.readdirSync(dirPath), []);
});
test('initial verified browser claim persists, and survives a new store instance', (t) => {
  const { dirPath, fence } = fixture(t);
  fence.claimInitialBrowser({ workspaceId: owner().id });
  const reopened = createTloOwnershipFence(createDurableTloOwnershipStore({ dirPath }));
  assert.deepEqual(reopened.snapshot().state.owner, { kind: 'browser', id: owner().id });
  assert.equal(reopened.snapshot().state.generation, 1);
  assert.equal(fs.existsSync(path.join(dirPath, 'default.lock')), false);
});
test('stale revisions fail CAS rather than overwriting a newer generation', (t) => {
  const { dirPath, first, fence } = fixture(t);
  const before = fence.snapshot();
  fence.claimInitialBrowser({ workspaceId: owner().id });
  const old = {
    schema: 'eveos.tlo-ownership-fence.v1', scopeId: 'default',
    generation: 1, owner: { kind: 'browser', id: 'wrong-browser-identity' },
    handoff: null, turn: null
  };
  assert.equal(first.compareAndSwap('default', before.revision, old), false);
  const reopened = createDurableTloOwnershipStore({ dirPath });
  assert.equal(reopened.read('default').state.owner.id, owner().id);
});
test('a held or stale lock prevents all writes; no automatic cleanup', (t) => {
  const { dirPath, first } = fixture(t);
  const lock = path.join(dirPath, 'default.lock');
  fs.mkdirSync(lock);
  const proposal = { schema:'eveos.tlo-ownership-fence.v1', scopeId:'default',
    generation:1, owner:{ kind:'browser', id:owner().id }, handoff:null, turn:null };
  assert.equal(first.compareAndSwap('default', null, proposal), false);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(first.read('default'), null);
});
test('two store instances never both accept a stale compare-and-swap', (t) => {
  const { dirPath, first, fence } = fixture(t);
  fence.claimInitialBrowser({ workspaceId: owner().id });
  const before = first.read('default');
  const second = createDurableTloOwnershipStore({ dirPath });
  const a = structuredClone(before.state);
  const b = structuredClone(before.state);
  a.generation = 2; b.generation = 3;
  assert.equal(first.compareAndSwap('default', before.revision, a), true);
  assert.equal(second.compareAndSwap('default', before.revision, b), false);
  assert.equal(second.read('default').state.generation, 2);
});
test('idle prepared and acknowledged handoff survives store reopening', (t) => {
  const { dirPath, fence } = fixture(t);
  fence.claimInitialBrowser({ workspaceId: owner().id });
  const secret = 'durable-handoff-secret-0001';
  const prepared = fence.prepareHandoff({ from:owner(), to:{kind:'backend',id:'nexus-tlo-backend-01'},
    conversationDigest:'a'.repeat(64), sourceWorkspaceId:owner().id,
    acknowledgementSecret:secret });
  assert.equal(prepared.handoff.status, 'prepared');
  const restarted = createTloOwnershipFence(createDurableTloOwnershipStore({ dirPath }));
  const ack = restarted.acknowledgeHandoff({ handoffId: prepared.handoff.id,
    to:{kind:'backend',id:'nexus-tlo-backend-01'}, acknowledgementSecret:secret });
  assert.equal(ack.handoff.status, 'acknowledged');
  const committed = restarted.completeHandoff({ handoffId: prepared.handoff.id, from:owner() });
  assert.equal(committed.owner.kind, 'backend');
  assert.equal(committed.generation, 2);
});
test('an unresolved dispatched turn is fenced as unknown after simulated restart', (t) => {
  const { dirPath, fence } = fixture(t);
  fence.claimInitialBrowser({ workspaceId:owner().id });
  fence.reserveTurn({ owner:owner(), requestId:'dex-turn-restart-proof-01' });
  fence.markDispatched({ owner:owner(), requestId:'dex-turn-restart-proof-01' });
  const reopened = createTloOwnershipFence(createDurableTloOwnershipStore({ dirPath }));
  assert.equal(reopened.fenceRestart().turn.phase, 'unknown');
  assert.throws(() => reopened.prepareHandoff({ from:owner(), to:{kind:'backend', id:'backend-new-01'},
    conversationDigest:'a'.repeat(64), sourceWorkspaceId:owner().id,
    acknowledgementSecret:'durable-handoff-secret-0002' }), {code:'TLO_OWNER_BUSY'});
});
test('corrupt on-disk records are rejected, not silently reset', (t) => {
  const { dirPath, first } = fixture(t);
  fs.writeFileSync(path.join(dirPath, 'default.json'), '{not-json');
  assert.throws(() => first.read('default'), {code:'TLO_OWNER_STORE_CORRUPT'});
  assert.throws(() => first.compareAndSwap('default', null, {
    schema:'eveos.tlo-ownership-fence.v1', scopeId:'default', generation:0,
    owner:null,handoff:null,turn:null
  }), {code:'TLO_OWNER_STORE_CORRUPT'});
});
test('symlink ownership record cannot be used as authority', (t) => {
  const { dirPath, first } = fixture(t);
  const dest = path.join(dirPath,'outside.txt');
  fs.writeFileSync(dest, JSON.stringify({schema:STORE_SCHEMA}));
  try { fs.symlinkSync(dest, path.join(dirPath,'default.json')); }
  catch (err) { if (['EPERM','EACCES','ENOSYS'].includes(err.code)) return; throw err; }
  assert.throws(() => first.read('default'), {code:'TLO_OWNER_STORE_CORRUPT'});
});
test('invalid scope/path traversal and wrong-state scopes are rejected', (t) => {
  const { first } = fixture(t);
  assert.throws(() => first.read('../../outside'), {code:'TLO_OWNER_STORE_SCOPE_INVALID'});
  assert.throws(() => first.compareAndSwap('default', null, {
    schema:'eveos.tlo-ownership-fence.v1',scopeId:'other',generation:0,owner:null,handoff:null,turn:null
  }), {code:'TLO_OWNER_STORE_STATE_INVALID'});
});
test('distinct scopes do not overwrite each other', (t) => {
  const { dirPath, first } = fixture(t);
  const a = createTloOwnershipFence(first);
  a.claimInitialBrowser({scopeId:'default',workspaceId:'browser-alpha-01'});
  a.claimInitialBrowser({scopeId:'other',workspaceId:'browser-beta-01'});
  const reopened=createTloOwnershipFence(createDurableTloOwnershipStore({dirPath}));
  assert.equal(reopened.snapshot('default').state.owner.id,'browser-alpha-01');
  assert.equal(reopened.snapshot('other').state.owner.id,'browser-beta-01');
});
