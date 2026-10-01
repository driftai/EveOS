(() => {
  const STORAGE_KEY = 'browser-ai-bridge.chatgpt-app-mirror.v1';
  const PULSE_MS = 2500;
  const DISPATCH_BUSY_MS = 180000;

  function normalizeConversationUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return '';
      const match = url.pathname.match(/^\/c\/([A-Za-z0-9-]{8,128})\/?$/);
      if (!match) return '';
      return `https://chatgpt.com/c/${match[1]}`;
    } catch {
      return '';
    }
  }

  function mirrorIdentity(url) {
    const normalized = normalizeConversationUrl(url);
    return normalized ? `chatgpt-app-mirror:${normalized.slice('https://chatgpt.com/c/'.length)}` : '';
  }

  function createController({
    chromeApi = globalThis.chrome,
    getProvider,
    ensureProviderAdapter,
    waitForTabComplete,
    publishTabs = async () => {},
    safeSend = () => false,
    timers = globalThis,
    now = () => Date.now()
  } = {}) {
    let record = null;
    let pulseTimer = null;
    let syncInFlight = null;
    const activeRequests = new Map();

    function storage() {
      return chromeApi?.storage?.local || null;
    }

    async function save() {
      if (!storage()?.set) return false;
      if (!record?.url) {
        await storage().remove?.(STORAGE_KEY);
        return true;
      }
      await storage().set({ [STORAGE_KEY]: { ...record, savedAt: now() } });
      return true;
    }

    async function load() {
      if (!storage()?.get) return null;
      try {
        const payload = (await storage().get(STORAGE_KEY))?.[STORAGE_KEY];
        const url = normalizeConversationUrl(payload?.url);
        if (!url) return null;
        record = {
          url,
          tabId: Number.isInteger(Number(payload?.tabId)) ? Number(payload.tabId) : null,
          lastHardSyncAt: Number(payload?.lastHardSyncAt || 0) || 0
        };
        return { ...record };
      } catch {
        return null;
      }
    }

    async function exactTab(url = record?.url) {
      const wanted = normalizeConversationUrl(url);
      if (!wanted || !chromeApi?.tabs) return null;
      if (record?.tabId != null) {
        try {
          const current = await chromeApi.tabs.get(Number(record.tabId));
          if (normalizeConversationUrl(current?.url || current?.pendingUrl) === wanted) return current;
        } catch {}
      }
      const tabs = await chromeApi.tabs.query({ url: 'https://chatgpt.com/*' });
      return tabs.find((tab) => normalizeConversationUrl(tab.url || tab.pendingUrl) === wanted) || null;
    }

    async function ensureTab({ create = true } = {}) {
      if (!record?.url) return null;
      let tab = await exactTab(record.url);
      if (!tab && create) tab = await chromeApi.tabs.create({ url: record.url, active: false });
      if (!tab?.id) return null;
      if (tab.status !== 'complete' && typeof waitForTabComplete === 'function') {
        tab = await waitForTabComplete(tab.id);
      }
      const provider = getProvider?.('chatgpt');
      if (!provider) throw new Error('ChatGPT provider is unavailable for App Mirror.');
      await ensureProviderAdapter?.(tab.id, provider);
      record.tabId = Number(tab.id);
      await save();
      return { tab, provider };
    }

    function isMirrorTab(tabId, url = '') {
      if (!record?.url) return false;
      const idMatches = record.tabId != null && Number(tabId) === Number(record.tabId);
      const urlMatches = normalizeConversationUrl(url) === record.url;
      return idMatches || urlMatches;
    }

    function decorateTarget(target = {}) {
      if (!isMirrorTab(target.id, target.url)) return target;
      const identity = mirrorIdentity(record?.url || target.url);
      return {
        ...target,
        title: target.title?.startsWith('[App Mirror] ') ? target.title : `[App Mirror] ${target.title || 'ChatGPT'}`,
        targetTypeId: 'chatgpt-app-mirror',
        targetTypeName: 'ChatGPT App Mirror',
        transport: 'browser-extension-app-mirror',
        sessionOrigin: 'chatgpt-app-mirror',
        appMirror: true,
        mirrorUrl: record?.url || normalizeConversationUrl(target.url),
        concreteTargetIdentity: {
          kind: 'chatgpt-app-mirror',
          conversationUrl: record?.url || normalizeConversationUrl(target.url),
          tabId: target.id,
          windowId: target.windowId,
          providerId: 'chatgpt',
          identity
        }
      };
    }

    function pruneBusy() {
      const stamp = now();
      for (const [requestId, until] of activeRequests) {
        if (until <= stamp) activeRequests.delete(requestId);
      }
    }

    function noteDispatch(tabId, requestId) {
      if (!requestId || !isMirrorTab(tabId)) return false;
      activeRequests.set(String(requestId), now() + DISPATCH_BUSY_MS);
      return true;
    }

    function noteFinal(tabId, requestId) {
      if (!requestId || !isMirrorTab(tabId)) return false;
      return activeRequests.delete(String(requestId));
    }

    function busy() {
      pruneBusy();
      return activeRequests.size > 0;
    }

    async function rescan(tabId) {
      try {
        return await chromeApi.tabs.sendMessage(Number(tabId), { type: 'dex_provider_control_rescan' });
      } catch {
        return null;
      }
    }

    async function sync({ hard = false, requestId = null } = {}) {
      if (syncInFlight) return syncInFlight;
      syncInFlight = (async () => {
        const resolved = await ensureTab({ create: true });
        if (!resolved?.tab?.id) throw new Error('ChatGPT App Mirror tab is unavailable.');
        if (hard && busy()) {
          const error = new Error('ChatGPT App Mirror is handling a Nexus turn; hard sync is deferred.');
          error.code = 'APP_MIRROR_BUSY';
          throw error;
        }
        let tab = resolved.tab;
        if (hard) {
          await chromeApi.tabs.reload(tab.id, { bypassCache: true });
          if (typeof waitForTabComplete === 'function') tab = await waitForTabComplete(tab.id);
          await ensureProviderAdapter?.(tab.id, resolved.provider);
          record.lastHardSyncAt = now();
          await save();
        }
        await rescan(tab.id);
        await publishTabs({ force: true });
        const detail = {
          ok: true,
          requestId,
          hard: !!hard,
          url: record.url,
          tabId: Number(tab.id),
          busy: busy(),
          syncedAt: now()
        };
        safeSend({ type: 'app_mirror_synced', ...detail });
        return detail;
      })().finally(() => { syncInFlight = null; });
      return syncInFlight;
    }

    async function ensure(url, { requestId = null } = {}) {
      const normalized = normalizeConversationUrl(url);
      if (!normalized) {
        const error = new Error('ChatGPT App Mirror requires an exact https://chatgpt.com/c/<conversation-id> URL.');
        error.code = 'APP_MIRROR_BAD_URL';
        throw error;
      }
      record = { url: normalized, tabId: record?.url === normalized ? record.tabId : null, lastHardSyncAt: 0 };
      await save();
      const resolved = await ensureTab({ create: true });
      await rescan(resolved.tab.id);
      start();
      await publishTabs({ force: true });
      const target = decorateTarget({
        id: resolved.tab.id,
        windowId: resolved.tab.windowId,
        title: resolved.tab.title || 'ChatGPT',
        url: resolved.tab.url || resolved.tab.pendingUrl || normalized,
        targetClassId: 'online-origin',
        targetTypeId: 'browser-tab',
        targetTypeName: 'Browser Tab',
        providerId: 'chatgpt',
        providerName: resolved.provider.name,
        transport: 'browser-extension',
        sessionOrigin: 'browser',
        capabilities: { ...(resolved.provider.capabilities || {}) }
      });
      return { target, tab: resolved.tab, provider: resolved.provider };
    }

    async function pulse() {
      if (!record?.url || busy()) return false;
      const resolved = await ensureTab({ create: true }).catch(() => null);
      if (!resolved?.tab?.id) return false;
      await rescan(resolved.tab.id);
      return true;
    }

    function start() {
      if (pulseTimer != null || !record?.url) return;
      pulseTimer = timers.setInterval(() => { void pulse(); }, PULSE_MS);
    }

    function stop() {
      if (pulseTimer != null) timers.clearInterval(pulseTimer);
      pulseTimer = null;
    }

    async function restore() {
      await load();
      if (!record?.url) return null;
      start();
      void pulse();
      return snapshot();
    }

    async function clear() {
      stop();
      activeRequests.clear();
      record = null;
      await save();
      await publishTabs({ force: true });
      return true;
    }

    async function onTabRemoved(tabId) {
      if (!record || Number(tabId) !== Number(record.tabId)) return false;
      record.tabId = null;
      await save();
      return true;
    }

    function onTabUpdated(tabId, changeInfo = {}, tab = null) {
      if (!record || Number(tabId) !== Number(record.tabId)) return false;
      if (changeInfo.url && normalizeConversationUrl(changeInfo.url) !== record.url) {
        record.tabId = null;
        void save();
        return true;
      }
      if (changeInfo.status === 'complete') void rescan(tabId);
      return true;
    }

    function snapshot() {
      pruneBusy();
      return {
        configured: !!record?.url,
        url: record?.url || '',
        tabId: record?.tabId ?? null,
        busy: activeRequests.size > 0,
        activeRequests: activeRequests.size,
        lastHardSyncAt: record?.lastHardSyncAt || 0
      };
    }

    return {
      ensure, sync, restore, clear, snapshot, decorateTarget, isMirrorTab,
      noteDispatch, noteFinal, onTabRemoved, onTabUpdated, pulse, start, stop
    };
  }

  const api = {
    STORAGE_KEY,
    PULSE_MS,
    DISPATCH_BUSY_MS,
    normalizeConversationUrl,
    mirrorIdentity,
    createController
  };
  globalThis.BrowserAiBridgeChatGptAppMirror = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
