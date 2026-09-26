(() => {
  const contractApi = globalThis.BrowserAiBridgeProviderContract
    || (typeof module !== 'undefined' && module.exports ? require('./provider-contract.js') : null);
  if (!contractApi) throw new Error('Provider contract module failed to load.');
  const ADAPTER_REVISION_FILE = 'content/provider-adapter-revision.js';
  const ADAPTER_REVISION_GLOBALS = [
    '__browserAiBridgeProviderAdapterRevisionLoaded',
    'BrowserAiBridgeProviderAdapterRevision'
  ];

  const PROVIDER_HEALTH_GROUP = {
    pingType: 'provider_health_ping',
    expectedAdapter: 'provider-health',
    files: ['content/provider-health.js'],
    globals: ['__browserAiBridgeProviderHealthLoaded', 'BrowserAiBridgeProviderHealthContent']
  };

  const PROVIDER_CONTROL_GROUP = {
    pingType: 'dex_provider_control_ping',
    expectedAdapter: 'dex-provider-control',
    files: ['content/dex-provider-control.js'],
    globals: [
      '__browserAiBridgeDexProviderControlLoaded',
      'BrowserAiBridgeDexProviderControlContent'
    ]
  };

  const PROVIDERS = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      matchPatterns: ['https://chat.deepseek.com/*'],
      urlPrefixes: ['https://chat.deepseek.com/'],
      capabilities: {
        chat: true,
        captureLatest: true,
        activity: true,
        searchResults: true
      },
      adapterContract: contractApi.createAdapterContract({
        operations: {
          probe: true, ensureReady: true, send: true, observe: true,
          captureLatest: true, recover: true, health: true
        }
      }),
      qualification: { live: true, warmRecovery: true, exactOnce: true, urlPrefix: 'https://chat.deepseek.com/' },
      groups: [
        {
          pingType: 'bridge_ping',
          expectedAdapter: 'deepseek',
          files: [
            'content/deepseek-input.js',
            'content/deepseek-answer.js',
            'content/deepseek.js'
          ],
          globals: [
            '__browserAiBridgeDeepSeekInputLoaded',
            '__browserAiBridgeDeepSeekAnswerLoaded',
            '__browserAiBridgeDeepSeekLoaded',
            'BrowserAiBridgeDeepSeekInput',
            'BrowserAiBridgeDeepSeekAnswer'
          ]
        },
        {
          pingType: 'activity_bridge_ping',
          expectedAdapter: 'visible-activity',
          files: [
            'content/activity-search.js',
            'content/activity.js'
          ],
          globals: [
            '__browserAiBridgeActivitySearchLoaded',
            '__browserAiBridgeVisibleActivityLoaded',
            'BrowserAiBridgeActivitySearch'
          ]
        },
        {
          pingType: 'search_recovery_ping',
          expectedAdapter: 'search-recovery-v2',
          files: ['content/search-recovery.js'],
          globals: ['__browserAiBridgeSearchRecoveryLoaded']
        }
      ]
    },
    {
      id: 'grok',
      name: 'Grok',
      matchPatterns: [
        'https://grok.com/*',
        'https://x.com/i/grok*'
      ],
      urlPrefixes: [
        'https://grok.com/',
        'https://x.com/i/grok'
      ],
      capabilities: {
        chat: true,
        captureLatest: true,
        activity: true,
        searchResults: false
      },
      adapterContract: contractApi.createAdapterContract({
        operations: {
          probe: true, ensureReady: true, send: true, observe: true,
          captureLatest: true, recover: true, health: true
        }
      }),
      qualification: { live: true, warmRecovery: true, exactOnce: true, urlPrefix: 'https://grok.com/' },
      groups: [
        {
          pingType: 'bridge_ping',
          expectedAdapter: 'grok',
          files: [
            'content/grok-input.js',
            'content/grok-answer.js',
            'content/grok.js'
          ],
          globals: [
            '__browserAiBridgeGrokInputLoaded',
            '__browserAiBridgeGrokAnswerLoaded',
            '__browserAiBridgeGrokLoaded',
            'BrowserAiBridgeGrokInput',
            'BrowserAiBridgeGrokAnswer'
          ]
        },
        {
          pingType: 'grok_activity_ping',
          expectedAdapter: 'grok-visible-activity',
          files: ['content/grok-activity.js'],
          globals: [
            '__browserAiBridgeGrokActivityLoaded',
            'BrowserAiBridgeGrokActivity'
          ]
        }
      ]
    },
    {
      id: 'claude',
      name: 'Claude',
      matchPatterns: ['https://claude.ai/*'],
      urlPrefixes: ['https://claude.ai/'],
      capabilities: {
        chat: true,
        captureLatest: true,
        activity: true,
        searchResults: false
      },
      adapterContract: contractApi.createAdapterContract({
        operations: {
          probe: true, ensureReady: true, send: true, observe: true,
          captureLatest: true, recover: true, health: true
        }
      }),
      qualification: { live: true, warmRecovery: true, exactOnce: true, urlPrefix: 'https://claude.ai/' },
      groups: [
        {
          pingType: 'bridge_ping',
          expectedAdapter: 'claude',
          files: [
            'content/claude-input.js',
            'content/claude-answer.js',
            'content/claude.js'
          ],
          globals: [
            '__browserAiBridgeClaudeInputLoaded',
            '__browserAiBridgeClaudeAnswerLoaded',
            '__browserAiBridgeClaudeLoaded',
            'BrowserAiBridgeClaudeInput',
            'BrowserAiBridgeClaudeAnswer'
          ]
        },
        {
          pingType: 'claude_activity_ping',
          expectedAdapter: 'claude-visible-activity',
          files: [
            'content/claude-activity-search.js',
            'content/claude-activity-command.js',
            'content/claude-activity.js'
          ],
          globals: [
            '__browserAiBridgeClaudeActivitySearchLoaded',
            '__browserAiBridgeClaudeActivityCommandLoaded',
            '__browserAiBridgeClaudeActivityLoaded',
            'BrowserAiBridgeClaudeActivitySearch',
            'BrowserAiBridgeClaudeActivityCommand',
            'BrowserAiBridgeClaudeActivity'
          ]
        }
      ]
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      matchPatterns: ['https://chatgpt.com/*'],
      urlPrefixes: ['https://chatgpt.com/'],
      capabilities: {
        chat: true,
        captureLatest: true,
        activity: false,
        searchResults: false
      },
      adapterContract: contractApi.createAdapterContract({
        operations: {
          probe: true, ensureReady: true, send: true, observe: true,
          captureLatest: true, recover: true, health: true
        }
      }),
      qualification: { live: true, warmRecovery: true, exactOnce: true, urlPrefix: 'https://chatgpt.com/' },
      orchestration: { spawnUrl: 'https://chatgpt.com/' },
      groups: [
        {
          pingType: 'bridge_ping',
          expectedAdapter: 'chatgpt',
          files: [
            'content/response-deadline.js',
            'content/chatgpt-page-state.js',
            'content/chatgpt-input.js',
            'content/chatgpt-delivery-watchdog.js',
            'content/chatgpt-answer.js',
            'content/chatgpt-return.js',
            'content/chatgpt.js',
            'content/chatgpt-stream-nudge.js'
          ],
          globals: [
            '__browserAiBridgeChatGptPageStateLoaded',
            '__browserAiBridgeChatGptInputLoaded',
            '__browserAiBridgeChatGptDeliveryWatchdogLoaded',
            '__browserAiBridgeChatGptAnswerLoaded',
            '__browserAiBridgeChatGptLoaded',
            '__browserAiBridgeChatGptStreamNudgeLoaded',
            'BrowserAiBridgeResponseDeadline',
            'BrowserAiBridgeChatGptPageState',
            'BrowserAiBridgeChatGptInput',
            'BrowserAiBridgeChatGptDeliveryWatchdog',
            'BrowserAiBridgeChatGptAnswer'
          ]
        }
      ]
    },
    {
      id: 'gemini',
      name: 'Gemini',
      matchPatterns: [
        'https://gemini.google.com/*',
        'https://aistudio.google.com/*'
      ],
      urlPrefixes: [
        'https://gemini.google.com/',
        'https://aistudio.google.com/'
      ],
      capabilities: {
        chat: true,
        captureLatest: true,
        activity: false,
        searchResults: false
      },
      adapterContract: contractApi.createAdapterContract({
        operations: {
          probe: true, ensureReady: true, send: true, observe: true,
          captureLatest: true, recover: true, health: true
        }
      }),
      qualification: {
        live: true, warmRecovery: true, exactOnce: true, allowStartupRedirect: true,
        urlPrefix: 'https://gemini.google.com/',
        deniedWarmUrlPrefixes: ['https://aistudio.google.com/']
      },
      groups: [
        {
          pingType: 'bridge_ping',
          expectedAdapter: 'gemini',
          files: [
            'content/gemini-input.js',
            'content/gemini-answer.js',
            'content/gemini.js'
          ],
          globals: [
            '__browserAiBridgeGeminiInputLoaded',
            '__browserAiBridgeGeminiAnswerLoaded',
            '__browserAiBridgeGeminiLoaded',
            'BrowserAiBridgeGeminiInput',
            'BrowserAiBridgeGeminiAnswer'
          ]
        }
      ]
    },
    {
      id: 'muse',
      name: 'Muse',
      matchPatterns: ['https://muse.ai/*'],
      urlPrefixes: ['https://muse.ai/'],
      capabilities: {
        chat: true,
        captureLatest: true,
        activity: false,
        searchResults: false
      },
      agentFeatures: {
        persistentCloudComputer: true,
        backgroundTasks: true,
        proactiveMessages: true,
        approvals: true,
        artifacts: true
      },
      adapterContract: contractApi.createAdapterContract({
        operations: {
          probe: true, ensureReady: true, send: true, observe: true,
          captureLatest: true, recover: true, health: true
        }
      }),
      qualification: { live: true, warmRecovery: true, exactOnce: true, urlPrefix: 'https://muse.ai/' },
      orchestration: {
        spawnUrl: 'https://muse.ai/thread/new',
        readinessProbe: 'managed_worker_ready',
        firstTurnPrime: true,
        establishedUrlPrefix: 'https://muse.ai/thread/'
      },
      groups: [
        {
          pingType: 'bridge_ping',
          expectedAdapter: 'muse',
          files: [
            'content/prompt-delivery.js',
            'content/muse-input.js',
            'content/muse-answer.js',
            'content/muse.js'
          ],
          globals: [
            '__browserAiBridgePromptDeliveryLoaded',
            '__browserAiBridgeMuseInputLoaded',
            '__browserAiBridgeMuseAnswerLoaded',
            '__browserAiBridgeMuseLoaded',
            'BrowserAiBridgePromptDelivery',
            'BrowserAiBridgeMuseInput',
            'BrowserAiBridgeMuseAnswer'
          ]
        }
      ]
    }
  ].map((provider) => {
    const providerGroups = provider.groups.map((group) => group.expectedAdapter === provider.id
      ? {
          ...group,
          files: [ADAPTER_REVISION_FILE, ...group.files],
          globals: [...ADAPTER_REVISION_GLOBALS, ...group.globals]
        }
      : group);
    const groups = [...providerGroups, PROVIDER_CONTROL_GROUP, PROVIDER_HEALTH_GROUP];
    const registered = {
      ...provider,
      adapterContract: contractApi.cloneAdapterContract(provider.adapterContract),
      qualification: { ...(provider.qualification || { live: false, warmRecovery: false, exactOnce: false }) },
      groups,
      contentScripts: groups.flatMap((group) => group.files)
    };
    contractApi.assertProviderDefinition(registered);
    return registered;
  });

  contractApi.assertProviderRegistry(PROVIDERS);

  function getProvider(providerId) {
    return PROVIDERS.find((provider) => provider.id === providerId) || null;
  }

  function providerForUrl(url) {
    if (!url) return null;
    return PROVIDERS.find((provider) => provider.urlPrefixes.some((prefix) => url.startsWith(prefix))) || null;
  }

  function publicProviders() {
    return PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      capabilities: { ...provider.capabilities },
      adapterContract: contractApi.cloneAdapterContract(provider.adapterContract),
      qualification: { ...provider.qualification, deniedWarmUrlPrefixes: [...(provider.qualification?.deniedWarmUrlPrefixes || [])] },
      orchestration: { spawnable: !!provider.orchestration?.spawnUrl },
      ...(provider.agentFeatures ? { agentFeatures: { ...provider.agentFeatures } } : {})
    }));
  }

  const api = { ADAPTER_REVISION_FILE, ADAPTER_REVISION_GLOBALS, PROVIDER_HEALTH_GROUP, PROVIDERS, getProvider, providerForUrl, publicProviders, contractApi };
  globalThis.BrowserAiBridgeProviders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
