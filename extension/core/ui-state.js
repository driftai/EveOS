(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EveOSBridgeUIState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PREFIX = 'eveosBridgeExpandedV1:';
  function create({ chromeApi, onError = () => {} }) {
    const bound = new WeakSet(), values = new Map(), elements = new Map();
    function apply(key, open) {
      values.set(key, open);
      for (const node of elements.get(key) || []) {
        if (node.isConnected) node.open = open;
        else elements.get(key).delete(node);
      }
    }
    const changed = (changes, area) => {
      if (area !== 'local') return;
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith(PREFIX) && typeof change.newValue === 'boolean') apply(key, change.newValue);
      }
    };
    chromeApi.storage.onChanged?.addListener(changed);
    async function bind(container) {
      const nodes = [...container.querySelectorAll('details[data-collapse]')].filter(node => !bound.has(node));
      const keys = nodes.map(node => PREFIX + node.dataset.collapse);
      if (!keys.length) return;
      const saved = await chromeApi.storage.local.get(keys);
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index], key = keys[index];
        if (!node.dataset.collapse || node.dataset.collapse.length > 160) throw new Error('Invalid layout key');
        const open = typeof saved[key] === 'boolean' ? saved[key] : values.get(key) ?? node.open;
        values.set(key, open); node.open = open; bound.add(node);
        if (!elements.has(key)) elements.set(key, new Set());
        for (const stale of elements.get(key)) if (!stale.isConnected) elements.get(key).delete(stale);
        elements.get(key).add(node);
        node.addEventListener('toggle', () => {
          if (values.get(key) === node.open) return;
          apply(key, node.open);
          void chromeApi.storage.local.set({ [key]:node.open }).catch(onError);
        });
      }
    }
    return Object.freeze({ bind, dispose() { chromeApi.storage.onChanged?.removeListener(changed); } });
  }
  return Object.freeze({ PREFIX, create });
});
