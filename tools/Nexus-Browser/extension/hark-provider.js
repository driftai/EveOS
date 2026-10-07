(() => {
  const registry = globalThis.BrowserAiBridgeProviders
    || (typeof module !== 'undefined' && module.exports ? require('./providers.js') : null);
  if (!registry?.contractApi) throw new Error('Hark provider requires the Nexus provider registry.');

  const contractApi = registry.contractApi;
  const targetMatchPatterns = [
    'https://hark.com/chat*',
    'https://hark.com/projects/*'
  ];
  const targetUrlPrefixes = [
    'https://hark.com/chat',
    'https://hark.com/projects/'
  ];
  const qualification = {
    live: true,
    warmRecovery: true,
    exactOnce: true,
    allowStartupRedirect: true,
    urlPrefix: 'https://hark.com/',
    deniedWarmUrlPrefixes: ['https://hark.com/login']
  };
  const orchestration = {
    spawnUrl: 'https://hark.com/chat',
    establishedUrlPrefixes: ['https://hark.com/chat', 'https://hark.com/projects/']
  };

  // Hark may already be present in the canonical provider registry when another remote agent has
  // advanced providers.js. Refine that same registered object in place instead of creating a second
  // provider. The canonical registry map has already attached adapter-revision, Dex-control and
  // provider-health groups, so all existing service-worker closures continue to use this one object.
  const existing = registry.getProvider?.('hark');
  if (existing) {
    existing.matchPatterns = [...targetMatchPatterns];
    existing.urlPrefixes = [...targetUrlPrefixes];
    existing.qualification = { ...existing.qualification, ...qualification };
    existing.orchestration = { ...(existing.orchestration || {}), ...orchestration };
    contractApi.assertProviderDefinition(existing);
    contractApi.assertProviderRegistry(registry.PROVIDERS);
    globalThis.BrowserAiBridgeHarkProvider = existing;
    if (typeof module !== 'undefined' && module.exports) module.exports = existing;
    return;
  }

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
    matchPatterns: [...targetMatchPatterns],
    urlPrefixes: [...targetUrlPrefixes],
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
    qualification,
    orchestration,
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
