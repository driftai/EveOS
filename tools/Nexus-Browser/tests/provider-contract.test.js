const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../extension/provider-contract.js');
const { PROVIDERS } = require('../extension/providers.js');
const continuity = require('../public/dex-agent-continuity.js');

function fakeProvider(overrides = {}) {
  const id = overrides.id || 'future-provider';
  return {
    id,
    name: overrides.name || 'Future Provider',
    matchPatterns: overrides.matchPatterns || ['https://future.example/*'],
    urlPrefixes: overrides.urlPrefixes || ['https://future.example/'],
    capabilities: overrides.capabilities || { chat: true, captureLatest: true, activity: false, searchResults: false },
    agentFeatures: overrides.agentFeatures || {},
    ...('orchestration' in overrides ? { orchestration: overrides.orchestration } : {}),
    adapterContract: overrides.adapterContract || contract.createAdapterContract({ operations: Object.fromEntries(contract.ADAPTER_OPERATIONS.map((operation) => [operation, true])) }),
    qualification: overrides.qualification || { live: true, warmRecovery: true, exactOnce: true, urlPrefix: 'https://future.example/' },
    groups: overrides.groups || [
      { pingType: 'bridge_ping', expectedAdapter: id, files: ['content/future.js'], globals: [] },
      { pingType: 'dex_provider_control_ping', expectedAdapter: 'dex-provider-control', files: ['content/dex-provider-control.js'], globals: [] },
      { pingType: 'provider_health_ping', expectedAdapter: 'provider-health', files: ['content/provider-health.js'], globals: [] }
    ]
  };
}

test('all registered providers satisfy the same versioned adapter contract', () => {
  for (const provider of PROVIDERS) {
    assert.deepEqual(contract.validateProviderDefinition(provider), [], provider.id);
    assert.equal(provider.adapterContract.version, contract.PROVIDER_CONTRACT_VERSION, provider.id);
    assert.equal(provider.adapterContract.capabilitySchemaVersion, contract.CAPABILITY_SCHEMA_VERSION, provider.id);
    for (const operation of contract.ADAPTER_OPERATIONS) {
      assert.equal(contract.supportsOperation(provider, operation), true, provider.id + ':' + operation);
    }
  }
});

test('a non-Muse future provider can satisfy the contract without core changes', () => {
  const future = fakeProvider();
  assert.deepEqual(contract.validateProviderDefinition(future), []);
  assert.equal(contract.assertProviderDefinition(future), future);
});

test('schema drift fails closed instead of silently extending provider semantics', () => {
  const future = fakeProvider({
    capabilities: { chat: true, captureLatest: true, activity: false, searchResults: false, teleport: true }
  });
  assert.match(contract.validateProviderDefinition(future).join(' '), /unknown bridge capability/);
  assert.throws(() => contract.assertProviderDefinition(future), (error) => error.code === 'PROVIDER_CONTRACT_INVALID');
});

test('capability-aware onboarding is provider-name independent', () => {
  const features = { persistentCloudComputer: true, backgroundTasks: true, proactiveMessages: true, approvals: true, artifacts: true };
  const room = { agentCheckpoints: {}, members: [] };
  const member = { id: 'agent-x', name: 'Agent X', binding: { providerId: 'future-provider' } };
  const future = continuity.onboardingGuidance(room, member, { id: 'future-provider', agentFeatures: features });
  const other = continuity.onboardingGuidance(room, member, { id: 'totally-different', agentFeatures: features });
  assert.deepEqual(future, other);
  assert.match(future.providerNativeGuidance.join(' '), /persistent files\/workspace/);
});

test('shared Dex orchestration contains no provider-id string literals', () => {
  const root = path.resolve(__dirname, '..');
  const shared = [
    'server.js',
    'dex/server-routing.js',
    'dex/server-durability.js',
    'dex/server-scheduler.js',
    'dex/server-scheduler-recovery.js',
    'dex/server-scheduler-state.js',
    'dex/server-state-merge.js',
    'dex/server-local-relay.js',
    'dex/handoff-packet.js',
    'dex/provider-orchestration-policy.js',
    'dex/provider-target-spawn-routing.js',
    'extension/provider-target-spawn.js',
    'extension/content/prompt-delivery.js',
    'public/dex-provider-participants.js',
    'public/dex-protocol.js',
    'public/dex-mode.js',
    'public/dex-runtime-client.js',
    'public/dex-provider-control.js',
    'public/dex-provider-health.js',
    'public/dex-agent-continuity.js'
  ];
  for (const relative of shared) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const provider of PROVIDERS) {
      assert.equal(source.includes("'" + provider.id + "'"), false, relative + ':' + provider.id);
      assert.equal(source.includes('"' + provider.id + '"'), false, relative + ':' + provider.id);
    }
  }
});

test('only explicitly qualified providers advertise fresh-chat managed-worker spawning', () => {
  const spawnable = PROVIDERS
    .filter((provider) => !!provider.orchestration?.spawnUrl)
    .map((provider) => provider.id)
    .sort();
  assert.deepEqual(spawnable, ['chatgpt', 'hark', 'muse']);
  for (const provider of PROVIDERS) {
    const publicEntry = require('../extension/providers.js').publicProviders()
      .find((entry) => entry.id === provider.id);
    assert.equal(publicEntry.orchestration.spawnable, !!provider.orchestration?.spawnUrl, provider.id);
  }
});

test('managed-worker orchestration metadata is schema-validated', () => {
  const muse = PROVIDERS.find((provider) => provider.id === 'muse');
  const chatgpt = PROVIDERS.find((provider) => provider.id === 'chatgpt');
  assert.equal(muse.orchestration.readinessProbe, 'managed_worker_ready');
  assert.equal(muse.orchestration.firstTurnPrime, true);
  assert.equal(muse.orchestration.establishedUrlPrefix, 'https://muse.ai/thread/');
  assert.equal(chatgpt.orchestration.readinessProbe, undefined);
  assert.equal(chatgpt.orchestration.firstTurnPrime, undefined);

  const unknown = fakeProvider({
    id: 'bad-orchestration',
    orchestration: { spawnUrl: 'https://future.example/', mystery: true }
  });
  assert.match(contract.validateProviderDefinition(unknown).join(' '), /unknown orchestration field/);

  const missingSpawn = fakeProvider({
    id: 'probe-without-spawn',
    orchestration: { readinessProbe: 'managed_worker_ready' }
  });
  assert.match(contract.validateProviderDefinition(missingSpawn).join(' '), /readinessProbe requires spawnUrl/);

  const primeWithoutEstablishedSurface = fakeProvider({
    id: 'prime-without-established',
    orchestration: { spawnUrl: 'https://future.example/new', firstTurnPrime: true }
  });
  assert.match(
    contract.validateProviderDefinition(primeWithoutEstablishedSurface).join(' '),
    /firstTurnPrime requires establishedUrlPrefix/
  );

  const establishedWithoutPrime = fakeProvider({
    id: 'established-without-prime',
    orchestration: { spawnUrl: 'https://future.example/new', establishedUrlPrefix: 'https://future.example/thread/' }
  });
  assert.match(
    contract.validateProviderDefinition(establishedWithoutPrime).join(' '),
    /establishedUrlPrefix requires firstTurnPrime/
  );
});

test('new adapter contracts fail closed when operations are omitted', () => {
  const empty = contract.createAdapterContract();
  for (const operation of contract.ADAPTER_OPERATIONS) assert.equal(empty.operations[operation], false, operation);
});


test('registry rejects duplicate provider ids and URL-prefix ownership collisions', () => {
  const one = fakeProvider({ id: 'future-one', urlPrefixes: ['https://collision.example/'], matchPatterns: ['https://collision.example/*'] });
  const duplicateId = fakeProvider({ id: 'future-one', urlPrefixes: ['https://other.example/'], matchPatterns: ['https://other.example/*'] });
  assert.match(contract.validateProviderRegistry([one, duplicateId]).join(' '), /duplicate provider id/);

  const two = fakeProvider({ id: 'future-two', urlPrefixes: ['https://collision.example/'], matchPatterns: ['https://collision.example/*'] });
  assert.match(contract.validateProviderRegistry([one, two]).join(' '), /URL prefix already owned/);
  assert.throws(() => contract.assertProviderRegistry([one, two]), (error) => error.code === 'PROVIDER_REGISTRY_INVALID');
});


test('a partial future provider can declare only the operations it actually supports', () => {
  const partial = fakeProvider({
    id: 'capture-only',
    capabilities: { chat: false, captureLatest: true, activity: false, searchResults: false },
    adapterContract: contract.createAdapterContract({
      operations: {
        probe: true,
        ensureReady: true,
        send: false,
        observe: true,
        captureLatest: true,
        recover: false,
        health: true
      }
    }),
    qualification: { live: false, warmRecovery: false, exactOnce: false }
  });
  assert.deepEqual(contract.validateProviderDefinition(partial), []);
  assert.equal(contract.supportsOperation(partial, 'send'), false);
  assert.equal(contract.supportsOperation(partial, 'captureLatest'), true);
  assert.equal(contract.supportsOperation(partial, 'recover'), false);
});

test('live qualification still fails closed when a provider omits one required operation', () => {
  const partialLive = fakeProvider({
    id: 'partial-live',
    adapterContract: contract.createAdapterContract({
      operations: {
        probe: true,
        ensureReady: true,
        send: true,
        observe: true,
        captureLatest: true,
        recover: false,
        health: true
      }
    })
  });
  assert.match(contract.validateProviderDefinition(partialLive).join(' '), /live qualification requires recover operation/);
});

test('provider registry has no blanket operation grant or separate qualification policy table', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../extension/providers.js'), 'utf8');
  assert.doesNotMatch(source, /STANDARD_ADAPTER_CONTRACT/);
  assert.doesNotMatch(source, /QUALIFICATION_POLICIES/);
  assert.doesNotMatch(source, /Object\.fromEntries\(contractApi\.ADAPTER_OPERATIONS/);
});
