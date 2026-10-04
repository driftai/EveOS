const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const warm = require('../extension/qualification-warm-target.js');

function fixture({
  previousTarget = null,
  tabs = [
    { id: 1, url: 'https://muse.ai/', discarded: false },
    { id: 2, url: 'https://muse.ai/chat/other', discarded: false },
    { id: 10, url: 'https://muse.ai/?dex_qualification=run-1', discarded: false }
  ],
  readyIds = [1, 2]
} = {}) {
  const mutations = [];
  const chromeApi = {
    tabs: {
      async query() { return tabs; },
      async get(id) { return tabs.find((tab) => Number(tab.id) === Number(id)); },
      async sendMessage(tabId, message) {
        assert.equal(message.type, 'bridge_ping');
        return readyIds.includes(Number(tabId)) ? { ok: true, adapter: 'muse' } : { ok: false };
      },
      async reload() { mutations.push('reload'); },
      async update() { mutations.push('update'); },
      async remove() { mutations.push('remove'); },
      async create() { mutations.push('create'); }
    }
  };
  const record = {
    runId: 'run-1', providerId: 'muse', baselineTabIds: [1, 2],
    originalTabId: 10, replacementTabId: 11, pendingReplacementTabId: null,
    previousTarget
  };
  const provider = {
    id: 'muse', matchPatterns: ['https://muse.ai/*'], qualification: { live: true, warmRecovery: true, exactOnce: true },
    groups: [{ pingType: 'bridge_ping', expectedAdapter: 'muse' }]
  };
  const matchesProvider = (providerId, url) => providerId === 'muse' && String(url).startsWith('https://muse.ai/');
  return { chromeApi, record, provider, matchesProvider, mutations };
}

test('warm target must predate qualification and qualification-owned tabs are excluded', async () => {
  const f = fixture({ tabs: [{ id: 10, url: 'https://muse.ai/?dex_qualification=run-1' }] });
  await assert.rejects(() => warm.chooseWarmTarget(f), (error) => error.code === 'QUALIFICATION_WARM_TARGET_NOT_FOUND');
});

test('warm provider mismatch is refused before probing candidates', async () => {
  const f = fixture();
  f.provider = { ...f.provider, id: 'chatgpt' };
  await assert.rejects(() => warm.chooseWarmTarget(f), (error) => error.code === 'QUALIFICATION_WARM_PROVIDER_MISMATCH');
});

test('previously selected ready provider target is preferred over other warm candidates', async () => {
  const f = fixture({ previousTarget: { tabId: 2, providerId: 'muse', url: 'https://muse.ai/chat/other' } });
  const chosen = await warm.chooseWarmTarget(f);
  assert.equal(chosen.tab.id, 2);
  assert.equal(chosen.source, 'previous-selected');
  assert.deepEqual(f.mutations, []);
});

test('one unambiguous ready pre-existing target is selected', async () => {
  const f = fixture({ readyIds: [1] });
  const chosen = await warm.chooseWarmTarget(f);
  assert.equal(chosen.tab.id, 1);
  assert.equal(chosen.source, 'single-ready-candidate');
  assert.deepEqual(f.mutations, []);
});

test('explicit warm tab pin disambiguates multiple ready candidates without mutation', async () => {
  const f = fixture();
  const chosen = await warm.chooseWarmTarget({ ...f, requestedTabId: 2 });
  assert.equal(chosen.tab.id, 2);
  assert.equal(chosen.source, 'explicit-tab');
  assert.deepEqual(f.mutations, []);
});

test('explicit warm tab pin must reference an eligible pre-existing ready target', async () => {
  const f = fixture({ readyIds: [1] });
  await assert.rejects(
    () => warm.chooseWarmTarget({ ...f, requestedTabId: 99 }),
    (error) => error.code === 'QUALIFICATION_WARM_TARGET_PIN_INVALID'
  );
  await assert.rejects(
    () => warm.chooseWarmTarget({ ...f, requestedTabId: 2 }),
    (error) => error.code === 'QUALIFICATION_WARM_TARGET_PIN_NOT_READY'
  );
  assert.deepEqual(f.mutations, []);
});

test('ambiguous warm candidates block instead of guessing and expose safe pin choices', async () => {
  const f = fixture();
  await assert.rejects(
    () => warm.chooseWarmTarget(f),
    (error) => error.code === 'QUALIFICATION_WARM_TARGET_AMBIGUOUS'
      && /--warm-tab-id/.test(error.message)
      && /1 https:\/\/muse\.ai\//.test(error.message)
      && /2 https:\/\/muse\.ai\/chat\/other/.test(error.message)
  );
  assert.deepEqual(f.mutations, []);
});

test('existing but unready warm targets block without reload, navigation, activation, or close', async () => {
  const f = fixture({ readyIds: [] });
  await assert.rejects(() => warm.chooseWarmTarget(f), (error) => error.code === 'QUALIFICATION_WARM_TARGET_NOT_READY');
  assert.deepEqual(f.mutations, []);
});

test('warm selector uses ready-only bridge selection and preserves foreground identity', async () => {
  const f = fixture({
    previousTarget: { tabId: 1, providerId: 'muse', url: 'https://muse.ai/' },
    tabs: [{ id: 1, url: 'https://muse.ai/', discarded: false, active: false }, { id: 99, url: 'https://example.com/', active: true }]
  });
  f.record.baselineTabIds = [1, 99];
  const selections = [];
  const control = {
    async requireRun() { return f.record; },
    async bindRecoveryTarget(input) {
      assert.equal(input.tab.id, 1);
      return { tabId: 1, providerId: 'muse', url: 'https://muse.ai/', source: input.source };
    }
  };
  const data = await warm.selectRecoveryTarget({
    control, runId: 'run-1', providerId: 'muse',
    deps: {
      chromeApi: {
        tabs: {
          async query(query) { return query.active ? [{ id: 99 }] : f.chromeApi.tabs.query(query); },
          get: f.chromeApi.tabs.get,
          sendMessage: f.chromeApi.tabs.sendMessage
        }
      },
      getProvider: () => f.provider,
      providerMatchesUrl: (_provider, url) => f.matchesProvider('muse', url),
      getSelection: async () => f.record.previousTarget,
      async selectTarget(tabId, providerId, options) { selections.push({ tabId, providerId, options }); }
    }
  });
  assert.deepEqual(selections, [{ tabId: 1, providerId: 'muse', options: { readyOnly: true } }]);
  assert.equal(data.targetMode, 'preexisting-warm');
  assert.equal(data.focusSteal, false);
});

test('warm qualification send and capture stay probe-only and cannot invoke adapter reload recovery', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../extension/service-worker.js'), 'utf8');
  assert.match(source, /async function sendToTarget\(message, options = \{\}\)/);
  assert.match(source, /if \(options\.readyOnly\)[\s\S]*probeScript/);
  assert.match(source, /else await ensureProviderAdapter\(tabId, provider\)/);
  assert.match(source, /send_prompt[\s\S]*readyOnly: warmQualification, tabId: qualificationClaim \? authorizedTabId : null/);
  assert.match(source, /capture_latest[\s\S]*readyOnly: warmQualification, tabId: authorized \? authorizedTabId : null/);
  assert.match(source, /Warm qualification target disappeared and may not fall back to another tab/);
});


test('every qualification send/capture is pinned to the just-authorized tab instead of generic target fallback', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../extension/service-worker.js'), 'utf8');
  assert.match(source, /authorizedTabId = qualificationClaim \? Number\(qualificationClaim\.recoveryTarget\?\.tabId \?\? qualificationClaim\.tabId\)/);
  assert.match(source, /tabId: qualificationClaim \? authorizedTabId : null/);
  assert.match(source, /authorized \? Number\(authorized\.record\.recoveryTarget\?\.tabId \?\? authorized\.record\.tabId\)/);
  assert.match(source, /tabId: authorized \? authorizedTabId : null/);
  assert.match(source, /Qualification target disappeared and may not fall back to another tab/);
});


test('ordinary prompt accepted metadata still follows the resolved normal target', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../extension/service-worker.js'), 'utf8');
  assert.match(source, /type: 'prompt_accepted'[\s\S]*tabId: Number\(tab\.id\)[\s\S]*providerId: provider\.id/);
});


test('warm qualification refuses mutable AI Studio window-management dispatch', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../extension/service-worker.js'), 'utf8');
  assert.match(source, /warmQualification && isAiStudioTarget\(provider, tab\)/);
  assert.match(source, /QUALIFICATION_WARM_TARGET_UNSUPPORTED/);
});


test('warm qualification refuses providers that did not explicitly opt into the contract', async () => {
  const f = fixture();
  f.provider.qualification = { live: true, warmRecovery: false, exactOnce: true };
  await assert.rejects(
    () => warm.chooseWarmTarget(f),
    (error) => error.code === 'QUALIFICATION_WARM_TARGET_UNSUPPORTED'
  );
});

test('warm qualification policy excludes provider frontends through registry metadata', async () => {
  const f = fixture({
    tabs: [{ id: 1, url: 'https://aistudio.google.com/prompts/test', discarded: false }],
    readyIds: [1]
  });
  f.record.providerId = 'gemini';
  f.record.baselineTabIds = [1];
  f.provider = {
    id: 'gemini',
    matchPatterns: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'],
    groups: [{ pingType: 'bridge_ping', expectedAdapter: 'gemini' }],
    qualification: {
      live: true, warmRecovery: true, exactOnce: true,
      deniedWarmUrlPrefixes: ['https://aistudio.google.com/']
    }
  };
  f.matchesProvider = (providerId, url) => providerId === 'gemini'
    && (String(url).startsWith('https://gemini.google.com/') || String(url).startsWith('https://aistudio.google.com/'));
  await assert.rejects(
    () => warm.chooseWarmTarget(f),
    (error) => error.code === 'QUALIFICATION_WARM_TARGET_UNSUPPORTED'
  );
});


test('provider health observer is not required for warm adapter readiness', async () => {
  const calls = [];
  const chromeApi = {
    tabs: {
      async sendMessage(_tabId, msg) {
        calls.push(msg.type);
        if (msg.type === 'bridge_ping') return { ok: true, adapter: 'chatgpt' };
        throw new Error('health observer is not loaded yet');
      }
    }
  };
  const provider = {
    groups: [
      { pingType: 'bridge_ping', expectedAdapter: 'chatgpt' },
      { pingType: 'provider_health_ping', expectedAdapter: 'provider-health' }
    ]
  };
  assert.equal(await warm.probeProviderReady(chromeApi, provider, 7, 10), true);
  assert.deepEqual(calls, ['bridge_ping']);
});
