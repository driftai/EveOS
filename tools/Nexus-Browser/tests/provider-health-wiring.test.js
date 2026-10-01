const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS } = require('../extension/providers.js');

test('every provider manifest content-script bundle loads the shared health sensor', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.equal(manifest.content_scripts.length, PROVIDERS.length);
  for (const entry of manifest.content_scripts) {
    assert.equal(entry.js.includes('content/provider-health.js'), true, entry.matches.join(','));
  }
  for (const provider of PROVIDERS) {
    assert.equal(provider.contentScripts.includes('content/provider-health.js'), true, provider.id);
    assert.ok(provider.groups.some((group) => group.expectedAdapter === 'provider-health'), provider.id);
  }
});

test('service worker accepts health from non-selected supported tabs and republishes tab snapshots', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../extension/service-worker.js'), 'utf8');
  const targetList = fs.readFileSync(path.resolve(__dirname, '../extension/provider-target-list.js'), 'utf8');
  assert.match(source, /providerHealthApi\.handle\(msg, sender/);
  assert.match(source, /healthFor:\s*\(tabId\)\s*=>\s*providerHealthApi\.get\(tabId\)/);
  assert.match(targetList, /health:\s*healthFor\(tab\.id\)/);
  assert.match(source, /providerHealthApi\.forget\(tabId\)/);
  assert.match(source, /group\.expectedAdapter !== 'provider-health'/);
});

test('Base Mode prevents sends to a tab carrying blocking provider health', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  assert.match(source, /target\.health\?\.blocking/);
  assert.match(source, /sendPrompt\.disabled/);
});
