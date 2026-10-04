(() => {
  'use strict';

  function message(msg, { retryAction = 'retry' } = {}) {
    if (msg?.code !== 'HOST_ACCESS_REQUIRED') return null;
    const site = msg.detail?.pattern || 'this provider site';
    if (msg?.detail?.allSitesDeclared) {
      return `Chrome is withholding EveOS Nexus Browser's all-sites access for ${site}. Open the extension menu → This can read and change site data → On all sites once, then ${retryAction}.`;
    }
    return `Chrome site access is required for ${site}. Allow EveOS Nexus Browser on this site in Chrome's extension Site access, then ${retryAction}.`;
  }

  function assistantDisplayName({ message: input = {}, target = null, providerName = 'Provider' } = {}) {
    const base = input.providerName || target?.providerName || providerName;
    const isGemini = input.providerId === 'gemini' || target?.providerId === 'gemini';
    if (!isGemini) return base;
    const targetUrl = String(target?.url || '');
    if (targetUrl.startsWith('https://aistudio.google.com/')) return 'Gemini - AI Studio';
    if (targetUrl.startsWith('https://gemini.google.com/')) return 'Gemini - App';
    return base;
  }

  const api = Object.freeze({ message, assistantDisplayName });
  globalThis.BrowserAiBridgeHostAccessUi = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
