const test = require('node:test');
const assert = require('node:assert/strict');
const freshness = require('../extension/provider-adapter-freshness.js');

const provider = {
  id: 'future-provider',
  groups: [
    { pingType: 'bridge_ping', expectedAdapter: 'future-provider' },
    { pingType: 'provider_health_ping', expectedAdapter: 'provider-health' }
  ]
};

function chromeMock({ revision = freshness.ADAPTER_REVISION } = {}) {
  const calls = [];
  let activeRevision = revision;
  return {
    calls,
    api: {
      tabs: {
        async sendMessage(tabId, msg) {
          calls.push(['sendMessage', tabId, msg.type]);
          if (msg.type === 'provider_adapter_revision_ping') {
            if (!activeRevision) throw new Error('no revision listener');
            return { ok: true, adapter: 'provider-adapter-revision', revision: activeRevision };
          }
          const group = provider.groups.find((entry) => entry.pingType === msg.type);
          if (!group) throw new Error('unexpected message');
          return { ok: true, adapter: group.expectedAdapter };
        },
        async reload(tabId, options) {
          calls.push(['reload', tabId, options]);
          activeRevision = freshness.ADAPTER_REVISION;
        },
        async get(tabId) {
          calls.push(['get', tabId]);
          return { id: tabId, status: 'complete' };
        }
      }
    }
  };
}

test('current provider adapter revision does not reload the tab', async () => {
  const mock = chromeMock();
  const result = await freshness.ensure(42, provider, mock.api);
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, false);
  assert.equal(mock.calls.filter((entry) => entry[0] === 'reload').length, 0);
});

test('stale provider adapter revision reloads the exact tab once and waits for all groups', async () => {
  const mock = chromeMock({ revision: 0 });
  const result = await freshness.ensure(77, provider, mock.api);
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.previousRevision, 0);
  assert.deepEqual(mock.calls.filter((entry) => entry[0] === 'reload'), [
    ['reload', 77, { bypassCache: true }]
  ]);
  for (const group of provider.groups) {
    assert.ok(mock.calls.some((entry) => entry[0] === 'sendMessage' && entry[2] === group.pingType));
  }
});

test('older adapter revision is treated as stale', () => {
  assert.equal(freshness.current({ ok: true, revision: freshness.ADAPTER_REVISION - 1 }), false);
  assert.equal(freshness.current({ ok: true, revision: freshness.ADAPTER_REVISION }), true);
});


test('adapter revision advances for safe pre-gesture ChatGPT draft recovery', () => {
  assert.ok(freshness.ADAPTER_REVISION >= 47);
});
