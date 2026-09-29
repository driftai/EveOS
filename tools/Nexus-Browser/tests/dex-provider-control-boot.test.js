const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const boot = require('../extension/dex-provider-control-boot.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'dex-provider-control-boot.js'), 'utf8');

test('providerPatterns derives only manifests that contain the Dex watcher', () => {
  const manifest = {
    content_scripts: [
      { matches: ['https://chatgpt.com/*'], js: ['content/chatgpt.js', 'content/dex-provider-control.js'] },
      { matches: ['https://example.com/*'], js: ['content/example.js'] },
      { matches: ['https://muse.ai/*'], js: ['content/muse.js', 'content/dex-provider-control.js'] }
    ]
  };
  assert.deepEqual(boot.providerPatterns(manifest), ['https://chatgpt.com/*', 'https://muse.ai/*']);
});

test('official package discovers Dex watchers only in its own namespaced module', () => {
  const previous = globalThis.BrowserAiBridgeExtensionAssets;
  globalThis.BrowserAiBridgeExtensionAssets = { path: value => 'modules/nexus-browser/' + value };
  try {
    assert.deepEqual(boot.providerPatterns({ content_scripts: [
      { matches: ['https://chatgpt.com/*'], js: ['modules/nexus-browser/content/dex-provider-control.js'] },
      { matches: ['https://example.com/*'], js: ['modules/unrelated/content/dex-provider-control.js'] }
    ] }), ['https://chatgpt.com/*']);
  } finally { globalThis.BrowserAiBridgeExtensionAssets = previous; }
});


test('provider-control boot self-heals the active stale provider tab after extension reload', () => {
  assert.match(source, /BrowserAiBridgeProviderAdapterFreshness/);
  assert.match(source, /freshness\.ensure\(tabId, provider, chrome\)/);
  assert.match(source, /refreshAdapter: !!tab\.active/);
  assert.match(source, /chrome\.tabs\.onActivated\?\.addListener/);
  assert.match(source, /scheduleBootstrap\(500\)/);
  assert.match(source, /scheduleBootstrap\(2500\)/);
});
