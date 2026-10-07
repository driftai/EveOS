'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rehydration = require('../extension/provider-content-rehydration.js');

function fakeChrome({ initiallyReady = false } = {}) {
  let ready = initiallyReady;
  const executions = [];
  return {
    executions,
    chrome: {
      tabs: {
        async query() {
          return [
            { id: 11, status: 'complete', url: 'https://chatgpt.com/c/reload-proof' },
            { id: 12, status: 'complete', url: 'https://example.com/' }
          ];
        },
        async sendMessage(tabId, message) {
          if (tabId !== 11 || message.type !== 'dex_provider_control_ping' || !ready) {
            throw new Error('Receiving end does not exist.');
          }
          return { ok: true, adapter: 'dex-provider-control' };
        }
      },
      scripting: {
        async executeScript(details) {
          executions.push(details);
          if (details.files?.includes('assembled/content/dex-provider-control.js')) ready = true;
          return [];
        }
      }
    }
  };
}

const providers = [{
  id: 'chatgpt',
  urlPrefixes: ['https://chatgpt.com/'],
  groups: [{
    pingType: 'dex_provider_control_ping',
    expectedAdapter: 'dex-provider-control',
    files: ['content/dex-provider-control.js'],
    globals: ['__browserAiBridgeDexProviderControlLoaded']
  }]
}];

test('worker boot rehydrates a stale provider-control scanner without reloading the page', async () => {
  const h = fakeChrome();
  const result = await rehydration.rehydrateOpenProviderTabs({
    chromeApi: h.chrome,
    providers,
    resolveAsset: (file) => `assembled/${file}`
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.rehydratedTabs, 1);
  assert.equal(result.rehydratedGroups, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(h.executions.some((entry) => entry.func), true, 'stale globals are cleared before reinjection');
  assert.equal(h.executions.some((entry) => entry.files?.[0] === 'assembled/content/dex-provider-control.js'), true);
  assert.equal(h.executions.some((entry) => entry.files?.some((file) => /reload/i.test(file))), false,
    'rehydration injects scripts in place and never reloads the provider tab');
});

test('healthy provider tabs are left untouched', async () => {
  const h = fakeChrome({ initiallyReady: true });
  const result = await rehydration.rehydrateOpenProviderTabs({ chromeApi: h.chrome, providers });

  assert.equal(result.scanned, 1);
  assert.equal(result.rehydratedTabs, 0);
  assert.equal(result.rehydratedGroups, 0);
  assert.deepEqual(result.failed, []);
  assert.equal(h.executions.length, 0);
});
