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
  assert.equal(manifest.name, 'EveOS Bridge');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.side_panel, undefined);
  assert(!manifest.permissions.includes('sidePanel'));
  assert.equal(typeof manifest.key, 'string');
  assert(manifest.key.length > 100, 'official hub must have a stable unpacked-extension ID');
  assert(manifest.optional_permissions.includes('management'));
  assert(!manifest.permissions.includes('management'));
  assert(!JSON.stringify(manifest).includes('<all_urls>'));
  assert(manifest.permissions.includes('scripting') && manifest.permissions.includes('activeTab'));
  // Capture permissions are allowed only because the Nexus module declares them for AudioFlix tab
  // audio; the Bridge must carry exactly the union of its modules, never extra capture authority.
  const nexusTool = json('tools', 'Nexus-Browser', 'extension', 'manifest.json');
  for (const permission of ['tabCapture', 'offscreen']) {
    assert.equal(manifest.permissions.includes(permission), nexusTool.permissions.includes(permission),
      `Bridge ${permission} must mirror the Nexus module`);
  }
  // Module pages live under modules/<id>/ in the Bridge; a bare offscreen URL would 404 there.
  const tabAudio = read('tools', 'Nexus-Browser', 'extension', 'audioflix-tab-audio.js');
  assert(tabAudio.includes("EveOSExtensionModuleRoots?.['nexus-browser']"),
    'AudioFlix offscreen page must resolve through the Bridge module root');
  const assembly = require('../extensions/assemble.cjs').audit();
  assert.equal(assembly.registry.length, 3);
  assert(assembly.files.has('modules/nexus-browser/content/chatgpt.js'));
  assert(assembly.files.has('modules/watchfusion/worker.js'));
  assert(assembly.files.has('modules/watchfusion/live-peer.js'));
  assert(assembly.files.has('modules/tab-collector/popup.html'));
  assert(manifest.content_scripts.every(group => group.js.every(file => file.startsWith('modules/nexus-browser/'))));
  for (const [file, bytes] of assembly.files) {
    if (file === 'modules/config.js') continue;
    const item = assembly.registry.find(module => file.startsWith(`modules/${module.id}/`));
    const original = fs.readFileSync(path.join(ROOT, item.source, file.slice(`modules/${item.id}/`.length)));
    assert(bytes.equals(original), `${file} must share canonical tool code`);
  }

  const protocol = require(path.join(ROOT, 'extension', 'core', 'protocol.js'));
  const catalog = require(path.join(ROOT, 'extension', 'core', 'catalog.js'));
  const discoveryApi = require(path.join(ROOT, 'extension', 'core', 'discovery.js'));
  assert.equal(protocol.CHANNEL, 'eveos.extension.v1');
  assert.equal(protocol.REQUESTS.INVOKE, 'invoke');
  assert.deepEqual(catalog.services.map(item => item.id), ['eveos', 'nexus-browser', 'watchfusion']);

  const saved = {};
  const installed = [
    { id: 'hub', name: manifest.name, description: manifest.description, enabled: true, type: 'extension' },
    { id: 'nexus', name: 'EveOS Nexus Browser', enabled: true, type: 'extension', version: '1' },
    { id: 'watch', name: 'WatchFusion Media Link', enabled: true, type: 'extension', version: '1' },
    { id: 'other', name: 'Future Tool', enabled: true, type: 'extension', version: '1' }
  ];
  const descriptors = {
    nexus: { id: 'nexus-browser', name: 'EveOS Nexus Browser', capabilities: ['Provider routing'], actions: [{ id: 'open-dashboard', label: 'Open Nexus' }] },
    watch: { id: 'watchfusion', name: 'WatchFusion Media Link', capabilities: ['Selected-tab media'], actions: [{ id: 'stop-sharing', label: 'Stop sharing' }] },
    other: { id: 'future-tool', name: 'Future Tool', capabilities: ['Future capability'], actions: [{ id: 'open-tool', label: 'Open tool' }] }
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
  assert.equal(scanned.connectors.length, 3);
  assert.equal(scanned.services.length, 3);
  assert.equal(scanned.connectors.find(item => item.id === 'watchfusion').actions[0].id, 'stop-sharing');
  assert(scanned.connectors.some(item => item.id === 'future-tool'), 'future protocol companions must not depend on hard-coded name matching');
  assert(scanned.services.every(item => item.online));
  assert.equal((await discovery.refresh()).connectors.length, 3);

  const nexusManifest = json('tools', 'Nexus-Browser', 'extension', 'manifest.json');
  const watchManifest = json('tools', 'WatchFusion', 'browser-extension', 'manifest.json');
  assert.deepEqual(nexusManifest.externally_connectable.ids, ['doioapjnmiknkdigmdoapoahlhcaikag']);
  assert.deepEqual(watchManifest.externally_connectable.ids, ['doioapjnmiknkdigmdoapoahlhcaikag']);
  assert.notDeepEqual(nexusManifest.externally_connectable.ids, ['*']);
  assert.notDeepEqual(watchManifest.externally_connectable.ids, ['*']);
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
    assert(source.includes("message.type === 'invoke'"));
    assert(!/(cookie|history|conversation|prompt)/i.test(source));
  }

  const panel = read('extension', 'hub.html');
  const docs = read('extension', 'README.md');
  assert(panel.includes('Nexus, Dex, WatchFusion, and Tab URLs are included'));
  assert(!read('extension', 'popup.js').includes('sidePanel'));
  const theme = read('extension', 'bridge-surfaces.css');
  assert(theme.includes('scrollbar-width:thin') && theme.includes('prefers-reduced-motion'));
  assert(!/@import|https?:\/\//.test(theme), 'Bridge styling must use local assets only');
  assert(read('extension', 'popup.js').includes("chrome.runtime.getURL('bridge-surfaces.css')"));
  assert(docs.includes('versioned `eveos.extension.v1`'));
  assert(docs.includes('Standalone + hub rule'));
  assert(docs.includes('never another maintained implementation'));
  const descriptor = catalog.descriptor({ id: 'watchfusion' }, { id: 'hub', moduleId: 'watchfusion', integration: 'included' });
  assert.equal(descriptor.moduleId, 'watchfusion');
  assert.equal(descriptor.integration, 'included');
  const media = await require('../extensions/media-regression.cjs').qualifyMediaWorker();
  const tabs = await require('../extensions/tab-collector-regression.cjs').qualifyTabCollector();
  const dashboard = await require('../extensions/dashboard-regression.cjs').qualifyDashboardOpen();
  const browser = process.argv.includes('--browser') ? await require('../extensions/qualify-browser.cjs').qualifyBrowser() : 0;
  console.log(`EVEOS_EXTENSION_HUB_SMOKE_OK media=${media} tabs=${tabs} dashboard=${dashboard} browser=${browser}`);
}

main().catch(error => {
  console.error(`EVEOS_EXTENSION_HUB_SMOKE_FAILED: ${error.message}`);
  process.exitCode = 1;
});
