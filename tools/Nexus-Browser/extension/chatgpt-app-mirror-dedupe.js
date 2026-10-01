(() => {
  const mirrorApi = globalThis.BrowserAiBridgeChatGptAppMirror
    || (typeof require === 'function' ? require('./chatgpt-app-mirror.js') : null);
  const CONFIG_KEY = mirrorApi?.STORAGE_KEY || 'browser-ai-bridge.chatgpt-app-mirror.v1';
  const COMMANDS_KEY = 'browser-ai-bridge.chatgpt-app-mirror.commands.v1';
  const COMMAND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const COMMAND_LIMIT = 256;

  function storage(chromeApi = globalThis.chrome) {
    return chromeApi?.storage?.local || null;
  }

  async function configuredUrl(chromeApi = globalThis.chrome) {
    const store = storage(chromeApi);
    if (!store?.get || !mirrorApi?.normalizeConversationUrl) return '';
    try {
      const value = (await store.get(CONFIG_KEY))?.[CONFIG_KEY]?.url;
      return mirrorApi.normalizeConversationUrl(value);
    } catch {
      return '';
    }
  }

  async function actionKey(sender, actionId, chromeApi = globalThis.chrome) {
    if (!actionId || !sender?.tab?.id || !mirrorApi?.normalizeConversationUrl) return '';
    const senderUrl = mirrorApi.normalizeConversationUrl(sender.tab.url);
    if (!senderUrl) return '';
    const configured = await configuredUrl(chromeApi);
    if (!configured || configured !== senderUrl) return '';
    return `${configured}|${String(actionId)}`;
  }

  async function read(chromeApi = globalThis.chrome, now = Date.now()) {
    const store = storage(chromeApi);
    if (!store?.get) return [];
    try {
      const value = (await store.get(COMMANDS_KEY))?.[COMMANDS_KEY];
      const cutoff = now - COMMAND_TTL_MS;
      return (Array.isArray(value) ? value : [])
        .filter((entry) => entry && typeof entry.key === 'string' && Number(entry.at) >= cutoff)
        .slice(-COMMAND_LIMIT);
    } catch {
      return [];
    }
  }

  async function seen(key, chromeApi = globalThis.chrome) {
    if (!key) return false;
    return (await read(chromeApi)).some((entry) => entry.key === key);
  }

  async function remember(key, chromeApi = globalThis.chrome, now = Date.now()) {
    if (!key) return false;
    const store = storage(chromeApi);
    if (!store?.set) return false;
    const entries = await read(chromeApi, now);
    const next = entries.filter((entry) => entry.key !== key);
    next.push({ key, at: now });
    await store.set({ [COMMANDS_KEY]: next.slice(-COMMAND_LIMIT) });
    return true;
  }

  const api = {
    CONFIG_KEY,
    COMMANDS_KEY,
    COMMAND_TTL_MS,
    COMMAND_LIMIT,
    configuredUrl,
    actionKey,
    read,
    seen,
    remember
  };
  globalThis.BrowserAiBridgeChatGptAppMirrorDedupe = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
