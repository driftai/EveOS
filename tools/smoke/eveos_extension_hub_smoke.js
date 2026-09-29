'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const json = (...parts) => JSON.parse(read(...parts));

async function main() {
  const manifest = json('extension', 'manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert(manifest.optional_permissions.includes('management'));
  assert(!manifest.permissions.includes('management'));
  assert(!JSON.stringify(manifest).includes('<all_urls>'));
  assert(manifest.host_permissions.every(value => /^http:\/\/(127\.0\.0\.1|localhost)\//.test(value)));
  assert(!manifest.content_scripts, 'the hub must not inject into provider pages');

  const protocol = require(path.join(ROOT, 'extension', 'core', 'protocol.js'));
  const catalog = require(path.join(ROOT, 'extension', 'core', 'catalog.js'));
  const discoveryApi = require(path.join(ROOT, 'extension', 'core', 'discovery.js'));
  assert.equal(protocol.CHANNEL, 'eveos.extension.v1');
  assert.deepEqual(catalog.services.map(item => item.id), ['eveos', 'nexus-browser', 'watchfusion']);

  const saved = {};
  const installed = [
    { id: 'hub', name: manifest.name, description: manifest.description, enabled: true, type: 'extension' },
    { id: 'nexus', name: 'EveOS Nexus Browser', enabled: true, type: 'extension', version: '1' },
    { id: 'watch', name: 'WatchFusion Media Link', enabled: true, type: 'extension', version: '1' },
    { id: 'other', name: 'Unrelated extension', enabled: true, type: 'extension', version: '1' }
  ];
  const descriptors = {
    nexus: { id: 'nexus-browser', name: 'EveOS Nexus Browser', capabilities: ['Provider routing'] },
    watch: { id: 'watchfusion', name: 'WatchFusion Media Link', capabilities: ['Selected-tab media'] }
  };
  const chromeApi = {
    runtime: {
      id: 'hub',
      async sendMessage(id, request) {
        assert(protocol.isRequest(request, protocol.REQUESTS.DESCRIBE));
        return protocol.response('describe', descriptors[id]);
      }
    },
    management: { async getAll() { return installed; } },
    storage: {
      local: {
        async get(key) { return { [key]: saved[key] }; },
        async set(value) { Object.assign(saved, value); }
      }
    }
  };
  const discovery = discoveryApi.create({
    chromeApi,
    fetchImpl: async url => ({
      ok: true,
      async json() { return { ok: true, url }; }
    })
  });
  const scanned = await discovery.scan();
  assert.equal(scanned.connectors.length, 2);
  assert.equal(scanned.services.length, 3);
  assert(scanned.services.every(item => item.online));
  assert.equal((await discovery.refresh()).connectors.length, 2);

  const nexusManifest = json('tools', 'Nexus-Browser', 'extension', 'manifest.json');
  const watchManifest = json('tools', 'WatchFusion', 'browser-extension', 'manifest.json');
  assert.deepEqual(nexusManifest.externally_connectable.ids, ['*']);
  assert.deepEqual(watchManifest.externally_connectable.ids, ['*']);
  const nexusEntry = read('tools', 'Nexus-Browser', 'extension', 'service-worker-entry.js');
  const watchWorker = read('tools', 'WatchFusion', 'browser-extension', 'worker.js');
  assert(nexusEntry.includes("importScripts('eveos-hub-connector.js')"));
  assert(watchWorker.includes("importScripts('eveos-hub-connector.js')"));
  for (const source of [
    read('tools', 'Nexus-Browser', 'extension', 'eveos-hub-connector.js'),
    read('tools', 'WatchFusion', 'browser-extension', 'eveos-hub-connector.js')
  ]) {
    assert(source.includes('chrome.runtime.onMessageExternal'));
    assert(source.includes("message.type === 'describe'"));
    assert(source.includes("message.type === 'status'"));
    assert(source.includes("message.type === 'open'"));
    assert(!/(cookie|history|conversation|prompt)/i.test(source));
  }

  const panel = read('extension', 'sidepanel.html');
  const docs = read('extension', 'README.md');
  assert(panel.includes('reads installed extension names and IDs only'));
  assert(docs.includes('versioned `eveos.extension.v1`'));
  console.log('EVEOS_EXTENSION_HUB_SMOKE_OK');
}

main().catch(error => {
  console.error(`EVEOS_EXTENSION_HUB_SMOKE_FAILED: ${error.message}`);
  process.exitCode = 1;
});
