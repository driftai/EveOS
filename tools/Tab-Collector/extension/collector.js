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
  const MAX_OPEN = 100;
  function parseUrls(text) {
    const urls = [], invalid = []; const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      try {
        if (!/^https?:\/\//i.test(token)) throw new Error('Unsupported scheme');
        const parsed = new URL(token);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error('Invalid URL');
        urls.push(parsed.href);
      } catch { invalid.push(token); }
    }
    return { urls, invalid, overLimit: urls.length > MAX_OPEN };
  }
  async function open(chromeApi, windowId, text) {
    if (!Number.isInteger(windowId) || windowId < 0) throw new Error('No browser window selected.');
    const parsed = parseUrls(text);
    if (parsed.overLimit) throw new Error(`Open up to ${MAX_OPEN} URLs per batch. Split the list; nothing was opened.`);
    if (!parsed.urls.length) return { opened: 0, failed: 0, invalid: parsed.invalid.length };
    const target = await chromeApi.windows.get(windowId);
    if (target?.id !== windowId || target.type !== 'normal') throw new Error('The original browser window is unavailable.');
    let opened = 0, failed = 0;
    for (const url of parsed.urls) {
      try { await chromeApi.tabs.create({ windowId, url, active: false }); opened++; }
      catch { failed++; }
    }
    return { opened, failed, invalid: parsed.invalid.length };
  }
  return Object.freeze({ collect, open, parseUrls, MAX_OPEN });
});
