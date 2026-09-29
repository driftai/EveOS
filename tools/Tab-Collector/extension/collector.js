(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EveOSTabCollector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  async function collect(chromeApi, windowId) {
    if (!Number.isInteger(windowId) || windowId < 0) throw new Error('No browser window selected.');
    const tabs = await chromeApi.tabs.query({ windowId });
    const rows = [...tabs].sort((a, b) => a.index - b.index).map(tab => ({
      url: String(tab.pendingUrl || tab.url || ''), title: String(tab.title || '')
    })).filter(tab => tab.url);
    return { count: rows.length, total: tabs.length, text: rows.map(tab => tab.url).join('\n') };
  }
  return Object.freeze({ collect });
});
