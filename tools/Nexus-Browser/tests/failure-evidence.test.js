const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeLog } = require('../scripts/runtime-log');
const { relevantSnippets, latestQualificationLog, terminalSignals } = require('../scripts/failure-snapshot');
const { failureExcerpt } = require('../scripts/qualify');
const { createProviderTargetSpawnRouting } = require('../dex/provider-target-spawn-routing');
const { createProviderControlRouting } = require('../dex/provider-control-routing');
const spawnApi = require('../extension/provider-target-spawn');

test('runtime log stays bounded while preserving newest terminal evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-log-'));
  const filePath = path.join(dir, 'server.log');
  const log = createRuntimeLog({ filePath, maxBytes: 220 });
  for (let i = 0; i < 30; i += 1) log.append(`line-${String(i).padStart(2, '0')} xxxxxxxxxx\n`);
  await log.flush();
  const text = fs.readFileSync(filePath, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 220);
  assert.match(text, /line-29/);
});

test('diagnostic snippets keep context around request matches and summarize terminal health signals', () => {
  const lines = [
    '[bridge] extension connected',
    '[bridge] extension tabs_update: 16 tab(s) detected',
    '[bridge] before request',
    '[bridge] incident PROMPT_DELIVERY_UNCOMMITTED [spawn-abc] source=provider-control-spawn',
    '[bridge] after request',
    '[bridge] extension disconnected',
    '[Bridge Supervisor] health failed 3 consecutive checks; restarting server PID 42',
    '[bridge] websocket error: reset',
    '[bridge] extension tabs_update: 17 tab(s) detected'
  ];
  const snippets = relevantSnippets(lines, ['spawn-abc'], 20, 1);
  assert.equal(snippets.matched, true);
  assert.deepEqual(snippets.lines, lines.slice(2, 5));
  assert.deepEqual(terminalSignals(lines), {
    extensionConnected: 1,
    extensionDisconnected: 1,
    supervisorRestarts: 1,
    websocketErrors: 1,
    recentTabCounts: [16, 17],
    lastTabCount: 17
  });
});

test('managed target routing preserves structured extension failure detail', async () => {
  const extension = { sent: [] };
  const routing = createProviderTargetSpawnRouting({
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    getExtensionSocket: () => extension
  });
  const promise = routing.spawn({ requestId: 'ctl-evidence', providerId: 'muse' });
  routing.observe({
    type: 'error',
    requestId: 'spawn-ctl-evidence',
    code: 'PROMPT_DELIVERY_UNCOMMITTED',
    message: 'not committed',
    detail: { spawnEvidence: { phase: 'first-turn-prime', tabId: 91 } }
  });
  await assert.rejects(() => promise, (error) => {
    assert.equal(error.code, 'PROMPT_DELIVERY_UNCOMMITTED');
    assert.deepEqual(error.detail, { spawnEvidence: { phase: 'first-turn-prime', tabId: 91 } });
    return true;
  });
});

test('provider-control records managed spawn failure evidence as an incident', async () => {
  const dex = { role: 'ui', clientKind: 'dex', sent: [] };
  const caller = { role: 'provider-control-extension', sent: [] };
  const source = {
    targetClassId: 'online-origin', targetId: 4, providerId: 'chatgpt',
    url: 'https://chatgpt.com/c/parent'
  };
  const state = {
    rooms: [{
      id: 'room-1', name: 'Worker Room', relay: { active: false, waitingFor: null },
      members: [{ id: 'parent', binding: { ...source } }]
    }]
  };
  const incidents = [];
  const error = Object.assign(new Error('prime failed'), {
    code: 'PROMPT_DELIVERY_UNCOMMITTED',
    detail: { spawnEvidence: { phase: 'first-turn-prime', tabId: 91, observedUrl: 'https://muse.ai/thread/new' } }
  });
  const routing = createProviderControlRouting({
    uiSockets: new Set([dex]),
    safeSend(ws, payload) { ws.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => state,
    spawnTarget: async () => { throw error; },
    recordIncident: (incident) => incidents.push(incident)
  });
  await routing.handle(caller, {
    type: 'provider_control_request',
    requestId: 'ctl-spawn-evidence',
    source,
    command: { action: 'spawn_agent', room: 'room-1', providerId: 'muse' }
  });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].roomId, 'room-1');
  assert.equal(incidents[0].source, 'provider-control-spawn');
  assert.equal(incidents[0].evidence.detail.spawnEvidence.phase, 'first-turn-prime');
  assert.deepEqual(caller.sent.find((entry) => entry.type === 'provider_control_result').result.data.failureDetail, error.detail);
  assert.equal(dex.sent.length, 0);
});

test('managed spawn failure adds lifecycle identity before cleaning the fresh tab', async () => {
  const removed = [];
  const tabs = new Map([[91, { id: 91, url: 'https://muse.ai/thread/new', status: 'complete' }]]);
  const chromeApi = {
    tabs: {
      async create() { return tabs.get(91); },
      async get(id) {
        if (!tabs.has(id)) throw new Error('No tab');
        return tabs.get(id);
      },
      async remove(id) { removed.push(id); tabs.delete(id); }
    }
  };
  const provider = {
    id: 'muse', name: 'Muse', urlPrefixes: ['https://muse.ai/'],
    orchestration: { spawnUrl: 'https://muse.ai/thread/new' }
  };
  await assert.rejects(() => spawnApi.spawn({
    type: 'spawn_target', requestId: 'spawn-phase-proof', providerId: 'muse'
  }, {
    chromeApi,
    getProvider: () => provider,
    waitForTabComplete: async (id) => chromeApi.tabs.get(id),
    ensureProviderAdapter: async () => { throw Object.assign(new Error('adapter failed'), { code: 'ADAPTER_FAILED' }); },
    publishTabs: async () => {},
    safeSend: () => true
  }), (error) => {
    assert.equal(error.code, 'ADAPTER_FAILED');
    assert.deepEqual(error.detail.spawnEvidence, {
      phase: 'ensure-provider-adapter',
      requestId: 'spawn-phase-proof',
      tabId: 91,
      providerId: 'muse',
      spawnUrl: 'https://muse.ai/thread/new',
      observedUrl: 'https://muse.ai/thread/new'
    });
    return true;
  });
  assert.deepEqual(removed, [91]);
});


test('qualification failure excerpt isolates the failing test block instead of only returning a log path', () => {
  const text = [
    'ok 1 - healthy',
    'some setup',
    'not ok 2 - broken resilience check',
    '  AssertionError [ERR_ASSERTION]: expected true',
    '  at test.js:10:2',
    'ok 3 - unrelated tail'
  ].join('\n');
  const excerpt = failureExcerpt(text, 20);
  assert.ok(excerpt.some((line) => /not ok 2/.test(line)));
  assert.ok(excerpt.some((line) => /ERR_ASSERTION/.test(line)));
});

test('diagnose exposes the newest qualification log failure excerpt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-qualification-'));
  const older = path.join(dir, 'older.log');
  const latest = path.join(dir, 'latest.log');
  fs.writeFileSync(older, 'not ok 1 - old failure\n', 'utf8');
  fs.writeFileSync(latest, 'setup\nnot ok 2 - newest failure\nAssertionError: boom\n', 'utf8');
  const past = new Date(Date.now() - 5000);
  fs.utimesSync(older, past, past);
  const evidence = latestQualificationLog(dir, 20);
  assert.equal(evidence.available, true);
  assert.equal(evidence.filePath, latest);
  assert.ok(evidence.failureExcerpt.some((line) => /newest failure/.test(line)));
  assert.ok(evidence.failureExcerpt.some((line) => /AssertionError/.test(line)));
});
