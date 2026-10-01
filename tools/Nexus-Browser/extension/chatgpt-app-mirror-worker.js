(() => {
  const mirrorApi = globalThis.BrowserAiBridgeChatGptAppMirror
    || (typeof require === 'function' ? require('./chatgpt-app-mirror.js') : null);

  function createIntegration({
    chromeApi = globalThis.chrome,
    getProvider,
    ensureProviderAdapter,
    waitForTabComplete,
    publishTabs,
    safeSend,
    rawFormatTarget
  } = {}) {
    if (!mirrorApi?.createController) throw new Error('ChatGPT App Mirror controller is unavailable.');
    if (typeof rawFormatTarget !== 'function') throw new Error('App Mirror requires a target formatter.');

    const controller = mirrorApi.createController({
      chromeApi,
      getProvider,
      ensureProviderAdapter,
      waitForTabComplete,
      publishTabs,
      safeSend
    });

    function decorateTarget(target) {
      return controller.decorateTarget(target) || target;
    }

    function formatTarget(tab, provider, options = {}) {
      return decorateTarget(rawFormatTarget(tab, provider, options));
    }

    async function handleBridgeCommand(msg, { selectTarget } = {}) {
      if (msg?.type === 'ensure_app_mirror') {
        const ensured = await controller.ensure(String(msg.url || ''), {
          requestId: msg.requestId || null
        });
        await selectTarget(Number(ensured.tab.id), 'chatgpt', {
          requestId: msg.requestId || null
        });
        safeSend({
          type: 'app_mirror_ready',
          requestId: msg.requestId || null,
          target: formatTarget(ensured.tab, ensured.provider),
          status: controller.snapshot()
        });
        return true;
      }
      if (msg?.type === 'sync_app_mirror') {
        await controller.sync({
          hard: msg.hard !== false,
          requestId: msg.requestId || null
        });
        return true;
      }
      if (msg?.type === 'request_app_mirror_status') {
        safeSend({
          type: 'app_mirror_status',
          requestId: msg.requestId || null,
          status: controller.snapshot()
        });
        return true;
      }
      return false;
    }

    function noteCommittedPrompt(providerId, tabId, requestId) {
      if (providerId !== 'chatgpt') return false;
      return controller.noteDispatch(tabId, requestId);
    }

    function noteRuntimeMessage(msg, sender) {
      if (!msg?.requestId || !['response_final', 'adapter_error'].includes(msg.type)) return false;
      return controller.noteFinal(sender?.tab?.id, msg.requestId);
    }

    return {
      controller,
      decorateTarget,
      formatTarget,
      handleBridgeCommand,
      noteCommittedPrompt,
      noteRuntimeMessage,
      restore: () => controller.restore(),
      onTabRemoved: (tabId) => controller.onTabRemoved(tabId),
      onTabUpdated: (tabId, changeInfo, tab) => controller.onTabUpdated(tabId, changeInfo, tab),
      snapshot: () => controller.snapshot()
    };
  }

  const api = { createIntegration };
  globalThis.BrowserAiBridgeChatGptAppMirrorWorker = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
