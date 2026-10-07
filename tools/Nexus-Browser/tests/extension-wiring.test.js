const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const { PROVIDERS } = require('../extension/providers.js');
const serviceWorkerEntry = fs.readFileSync(path.join(ROOT, 'extension', 'service-worker-entry.js'), 'utf8');

test('every provider has one matching ordered manifest content-script bundle', () => {
  for (const provider of PROVIDERS) {
    const entry = manifest.content_scripts.find((candidate) => {
      return JSON.stringify(candidate.matches || []) === JSON.stringify(provider.matchPatterns);
    });
    assert.ok(entry, `Missing manifest content-script entry for ${provider.name}`);
    const expected = [...provider.contentScripts];
    assert.deepEqual(entry.js, expected, `${provider.name} manifest order drifted from provider registry`);

    for (const relativePath of provider.contentScripts) {
      const absolutePath = path.join(ROOT, 'extension', relativePath);
      assert.equal(fs.existsSync(absolutePath), true, `Missing ${provider.name} content script: ${relativePath}`);
    }

  }
});

test('extension grants only supported providers and loopback while keeping injection provider-scoped', () => {
  const manifestMatches = manifest.content_scripts.flatMap((entry) => entry.matches || []);
  const providerMatches = PROVIDERS.flatMap((provider) => provider.matchPatterns);
  const hostPermissionCovers = (pattern) => {
    const origin = String(pattern).match(/^([a-z*]+:\/\/[^/]+)\//i)?.[1];
    return manifest.host_permissions.includes(pattern)
      || !!origin && manifest.host_permissions.includes(`${origin}/*`);
  };
  assert.equal(manifest.host_permissions.includes('<all_urls>'), false, 'Extension must not request all-sites access.');
  for (const pattern of providerMatches) {
    assert.equal(hostPermissionCovers(pattern), true, `Missing provider host permission: ${pattern}`);
  }
  assert.deepEqual([...new Set(manifestMatches)].sort(), [...new Set(providerMatches)].sort());
  assert.equal(manifestMatches.includes('<all_urls>'), false, 'Content scripts must stay restricted to supported AI providers.');
});

test('explicit loopback permissions cover runtime health and websocket coordination', () => {
  assert.equal(manifest.host_permissions.includes('http://127.0.0.1/*'), true);
  assert.equal(manifest.host_permissions.includes('http://localhost/*'), true);
});

test('service worker loads background dispatch before provider routing', () => {
  const dispatch = serviceWorkerEntry.indexOf("importScripts('background-dispatch.js')");
  const readiness = serviceWorkerEntry.indexOf("importScripts('tab-readiness.js')");
  const worker = serviceWorkerEntry.indexOf("importScripts('service-worker.js')");
  assert.ok(dispatch >= 0 && readiness > dispatch && worker > readiness);
});

test('service worker loads ChatGPT App Mirror modules before provider-control and transport startup', () => {
  const mirror = serviceWorkerEntry.indexOf("importScripts('chatgpt-app-mirror.js')");
  const dedupe = serviceWorkerEntry.indexOf("importScripts('chatgpt-app-mirror-dedupe.js')");
  const mirrorWorker = serviceWorkerEntry.indexOf("importScripts('chatgpt-app-mirror-worker.js')");
  const providerList = serviceWorkerEntry.indexOf("importScripts('provider-target-list.js')");
  const providerControl = serviceWorkerEntry.indexOf("importScripts('dex-provider-control-bridge.js')");
  const worker = serviceWorkerEntry.indexOf("importScripts('service-worker.js')");
  assert.ok(providerList >= 0 && mirror >= 0 && dedupe > mirror && mirrorWorker > dedupe
    && providerControl > mirrorWorker && worker > providerControl);
});
