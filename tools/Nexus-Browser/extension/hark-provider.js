(() => {
  const registry = globalThis.BrowserAiBridgeProviders
    || (typeof module !== 'undefined' && module.exports ? require('./providers.js') : null);
  if (!registry?.contractApi) throw new Error('Hark provider requires the Nexus provider registry.');

  const existing = registry.getProvider?.('hark');
  if (existing) {
    globalThis.BrowserAiBridgeHarkProvider = existing;
    if (typeof module !== 'undefined' && module.exports) module.exports = existing;
    return;
  }

  const contractApi = registry.contractApi;
  const providerControlGroup = {
    pingType: 'dex_provider_control_ping',
    expectedAdapter: 'dex-provider-control',
    files: ['content/dex-provider-control.js'],
    globals: [
      '__browserAiBridgeDexProviderControlLoaded',
      'BrowserAiBridgeDexProviderControlContent'
    ]
  };

  const primaryGroup = {
    pingType: 'bridge_ping',
    expectedAdapter: 'hark',
    files: [
      registry.ADAPTER_REVISION_FILE,
      'content/hark-input.js',
      'content/hark-answer.js',
      'content/hark.js'
    ],
    globals: [
      ...registry.ADAPTER_REVISION_GLOBALS,
      '__browserAiBridgeHarkInputLoaded',
      '__browserAiBridgeHarkAnswerLoaded',
      '__browserAiBridgeHarkLoaded',
      'BrowserAiBridgeHarkInput',
      'BrowserAiBridgeHarkAnswer'
    ]
  };

  const groups = [primaryGroup, providerControlGroup, registry.PROVIDER_HEALTH_GROUP];
  const registered = {
    id: 'hark',
    name: 'Hark',
    // Only chat/project workspaces become Nexus targets. The manifest grants host-wide permission so
    // the extension can survive Hark's authenticated navigation without advertising settings/login tabs.
    matchPatterns: [
      'https://hark.com/chat*',
      'https://hark.com/projects/*'
    ],
    urlPrefixes: [
      'https://hark.com/chat',
      'https://hark.com/projects/'
    ],
    capabilities: {
      chat: true,
      captureLatest: true,
      activity: false,
      searchResults: false
    },
    adapterContract: contractApi.createAdapterContract({
      operations: {
        probe: true,
        ensureReady: true,
        send: true,
        observe: true,
        captureLatest: true,
        recover: true,
        health: true
      }
    }),
    qualification: {
      live: true,
      warmRecovery: true,
      exactOnce: true,
      urlPrefix: 'https://hark.com/'
    },
    orchestration: {
      spawnUrl: 'https://hark.com/chat'
    },
    groups,
    contentScripts: groups.flatMap((group) => group.files)
  };

  registered.adapterContract = contractApi.cloneAdapterContract(registered.adapterContract);
  contractApi.assertProviderDefinition(registered);
  registry.PROVIDERS.push(registered);
  contractApi.assertProviderRegistry(registry.PROVIDERS);

  globalThis.BrowserAiBridgeHarkProvider = registered;
  if (typeof module !== 'undefined' && module.exports) module.exports = registered;
})();
