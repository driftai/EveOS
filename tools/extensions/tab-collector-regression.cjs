'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const TOOL = path.join(ROOT, 'tools/Tab-Collector/extension');

async function qualifyTabCollector() {
  const api = require(path.join(TOOL, 'collector.js'));
  const queries = [];
  const chrome = { tabs: { query: async info => {
    queries.push(info);
    return [{ windowId: 7, index: 2, url: 'chrome://newtab/' },
      { windowId: 7, index: 0, url: 'https://example.com/duplicate' },
      { windowId: 7, index: 1, url: 'https://example.com/duplicate' },
      { windowId: 7, index: 3, url: 'about:blank', pendingUrl: 'file:///fixture.txt' },
      { windowId: 7, index: 4 }];
  } } };
  const value = await api.collect(chrome, 7);
  assert.deepEqual(queries, [{ windowId: 7 }]);
  assert.equal(value.total, 5); assert.equal(value.count, 4);
  assert.equal(value.text, 'https://example.com/duplicate\nhttps://example.com/duplicate\nchrome://newtab/\nfile:///fixture.txt');
  await assert.rejects(api.collect(chrome, -1));
  await assert.rejects(api.collect(chrome, NaN));
  assert.equal(queries.length, 1, 'invalid scope must not query all windows');
  const empty = await api.collect({ tabs: { query: async () => [] } }, 0);
  assert.deepEqual(empty, { count: 0, total: 0, text: '' });

  const manifest = JSON.parse(fs.readFileSync(path.join(TOOL, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['tabs']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.externally_connectable.ids, ['doioapjnmiknkdigmdoapoahlhcaikag']);
  for (const file of ['collector.js', 'popup.js', 'worker.js', 'popup.css', 'popup.html']) {
    const source = fs.readFileSync(path.join(TOOL, file), 'utf8');
    assert(!/fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\.storage\b|https?:\/\//.test(source), `${file}: collector must stay local-only`);
  }
  let handler;
  vm.runInNewContext(fs.readFileSync(path.join(TOOL, 'worker.js'), 'utf8'), {
    chrome: { runtime: { getManifest: () => manifest } },
    EveOSExtensionModules: { register: (id, value) => { assert.equal(id, 'tab-collector'); handler = value; } }
  });
  const described = await handler({ type: 'describe' });
  assert.equal(described.detail.id, 'tab-collector');
  assert.equal(described.detail.actions, undefined);
  assert.equal((await handler({ type: 'collect' })).code, 'UNKNOWN_REQUEST', 'external callers cannot collect URLs');
  return 4;
}
module.exports = { qualifyTabCollector };
