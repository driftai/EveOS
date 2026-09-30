const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createTurnLedger } = require('../dex/turn-ledger');
const { createIncidentStore } = require('../dex/incident-store');
const { createServerDurability } = require('../dex/server-durability');
const { createDexStateStore } = require('../dex/state-store');
const localTargets = require('../local-targets/manager');
const { server, wss, HOST, configureDurability } = require('../server');

function startTestServer() {
  return new Promise((resolve) => {
    // Listen on ephemeral port 0
    server.listen(0, HOST, () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => new Promise((done) => {
          // HTTP closeAllConnections excludes upgraded WebSockets. A failed
          // assertion must not leave server.close waiting for those forever.
          for (const socket of wss.clients) socket.terminate();
          server.closeAllConnections?.();
          server.close(done);
        })
      });
    });
  });
}

function waitMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(data) {
      try {
        const msg = JSON.parse(String(data));
        if (!predicate || predicate(msg)) {
          cleanup();
          resolve(msg);
        }
      } catch (err) {
        // ignore parse errors for unmatched
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }

    ws.on('message', onMessage);
  });
}

test('Nexus Browser Protocol Suite', { timeout: 15000 }, async (t) => {
  let instance;
  let tempDir;
  let originalStores;

  t.before(async () => {
    // These are online bridge contracts, not native terminal discovery tests.
    // Synchronous host discovery can consume their message deadline under load.
    t.mock.method(localTargets, 'listLocalTargets', async () => []);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-bridge-protocol-'));
    const testLedger = createTurnLedger({ filePath: path.join(tempDir, 'dex-turn-ledger.jsonl') });
    const testIncidents = createIncidentStore({ filePath: path.join(tempDir, 'incidents.jsonl') });
    const testDurability = createServerDurability({ ledger: testLedger, incidents: testIncidents });
    const testStateStore = createDexStateStore({ filePath: path.join(tempDir, 'dex-state.json') });
    originalStores = configureDurability({ durability: testDurability, dexStateStore: testStateStore });
    instance = await startTestServer();
  });

  t.after(async () => {
    if (instance) await instance.close();
    if (originalStores) configureDurability(originalStores);
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  await t.test('GET /health returns 200 with service info', async () => {
    const res = await fetch(`http://${HOST}:${instance.port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, service: 'eveos-nexus-browser', port: 9088 });
  });

  await t.test('GET / serves index.html', async () => {
    const res = await fetch(`http://${HOST}:${instance.port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const text = await res.text();
    assert.match(text, /Nexus Browser/);
  });

  await t.test('UI receives error when extension is offline', async (t) => {
    const uiWs = new WebSocket(`ws://${HOST}:${instance.port}/ws`);
    t.after(() => uiWs.terminate());
    await new Promise((resolve) => uiWs.on('open', resolve));

    uiWs.send(JSON.stringify({ type: 'hello', role: 'ui' }));
    const statusMsg = await waitMessage(uiWs, (m) => m.type === 'bridge_status');
    assert.equal(statusMsg.connected, false);

    uiWs.send(JSON.stringify({ type: 'send_prompt', requestId: 'test-1', text: 'hello' }));
    const errMsg = await waitMessage(uiWs, (m) => m.type === 'error');
    assert.equal(errMsg.code, 'EXTENSION_OFFLINE');
    assert.equal(errMsg.requestId, 'test-1');

    uiWs.close();
  });

  await t.test('Full UI and Extension handshake and prompt routing round-trip', async (t) => {
    const uiWs = new WebSocket(`ws://${HOST}:${instance.port}/ws`);
    t.after(() => uiWs.terminate());
    await new Promise((resolve) => uiWs.on('open', resolve));
    uiWs.send(JSON.stringify({ type: 'hello', role: 'ui' }));

    const extWs = new WebSocket(`ws://${HOST}:${instance.port}/ws`);
    t.after(() => extWs.terminate());
    await new Promise((resolve) => extWs.on('open', resolve));
    const connected = waitMessage(uiWs, (m) => m.type === 'bridge_status' && m.connected === true);
    const tabsRequested = waitMessage(extWs, (m) => m.type === 'request_tabs');
    extWs.send(JSON.stringify({ type: 'hello', role: 'extension' }));

    // UI should be notified that extension connected
    const extConnected = await connected;
    assert.equal(extConnected.connected, true);

    // Extension should receive request_tabs
    const reqTabs = await tabsRequested;
    assert.equal(reqTabs.type, 'request_tabs');

    // Extension publishes tabs
    const mockTabs = [{ id: 42, title: 'DeepSeek - Test', url: 'https://chat.deepseek.com/' }];
    extWs.send(JSON.stringify({ type: 'tabs_update', tabs: mockTabs, target: null }));

    const uiTabs = await waitMessage(uiWs, (m) => m.type === 'tabs_update');
    assert.equal(uiTabs.tabs.length, 1);
    assert.equal(uiTabs.tabs[0].id, 42);

    // UI selects target tab 42
    uiWs.send(JSON.stringify({ type: 'select_target', tabId: 42 }));
    const extSelect = await waitMessage(extWs, (m) => m.type === 'select_target');
    assert.equal(extSelect.tabId, 42);

    // Extension confirms target selected
    extWs.send(JSON.stringify({ type: 'target_selected', target: mockTabs[0] }));
    const uiTarget = await waitMessage(uiWs, (m) => m.type === 'target_selected');
    assert.equal(uiTarget.target.id, 42);

    // UI sends prompt
    const reqId = `req-abc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    uiWs.send(JSON.stringify({ type: 'send_prompt', requestId: reqId, text: 'Reply with BRIDGE_OK_999' }));

    // Extension receives send_prompt
    const extPrompt = await waitMessage(extWs, (m) => m.type === 'send_prompt');
    assert.equal(extPrompt.requestId, reqId);
    assert.equal(extPrompt.text, 'Reply with BRIDGE_OK_999');

    // Extension simulates prompt acceptance
    extWs.send(JSON.stringify({ type: 'prompt_accepted', requestId: reqId, tabId: 42 }));
    const uiAccept = await waitMessage(uiWs, (m) => m.type === 'prompt_accepted');
    assert.equal(uiAccept.requestId, reqId);

    // Extension streams partial
    extWs.send(JSON.stringify({ type: 'response_partial', requestId: reqId, text: 'BRIDGE_OK' }));
    const uiPartial = await waitMessage(uiWs, (m) => m.type === 'response_partial');
    assert.equal(uiPartial.text, 'BRIDGE_OK');

    // Extension delivers final
    extWs.send(JSON.stringify({ type: 'response_final', requestId: reqId, text: 'BRIDGE_OK_999' }));
    const uiFinal = await waitMessage(uiWs, (m) => m.type === 'response_final');
    assert.equal(uiFinal.text, 'BRIDGE_OK_999');

    // Clean disconnect of extension
    extWs.close();
    const uiLost = await waitMessage(uiWs, (m) => m.type === 'bridge_status');
    assert.equal(uiLost.connected, false);

    uiWs.close();
  });

  await t.test('Routes request_search_results from UI to extension and search_results_result back to UI', async (t) => {
    const uiWs = new WebSocket(`ws://${HOST}:${instance.port}/ws`);
    t.after(() => uiWs.terminate());
    await new Promise((resolve) => uiWs.on('open', resolve));
    uiWs.send(JSON.stringify({ type: 'hello', role: 'ui' }));

    const extWs = new WebSocket(`ws://${HOST}:${instance.port}/ws`);
    t.after(() => extWs.terminate());
    await new Promise((resolve) => extWs.on('open', resolve));
    const connected = waitMessage(uiWs, (m) => m.type === 'bridge_status' && m.connected === true);
    const tabsRequested = waitMessage(extWs, (m) => m.type === 'request_tabs');
    extWs.send(JSON.stringify({ type: 'hello', role: 'extension' }));

    await connected;
    await tabsRequested;

    // UI requests search results for a specific turn stage
    const reqId = 'req-search-456';
    uiWs.send(JSON.stringify({
      type: 'request_search_results',
      requestId: reqId,
      searchIndex: 1
    }));

    // Extension receives request_search_results
    const extSearchReq = await waitMessage(extWs, (m) => m.type === 'request_search_results');
    assert.equal(extSearchReq.requestId, reqId);
    assert.equal(extSearchReq.searchIndex, 1);

    // Extension responds with search_results_result
    const mockResults = [
      {
        title: 'Current Central Time — Live CST / CDT Clock Now',
        domain: 'timeandcalendars.com',
        href: 'https://timeandcalendars.com/current-central-time',
        snippet: 'Central Standard Time (CST) is 6 hours behind UTC.'
      },
      {
        title: 'Time in New York City, New York, USA (LIVE)',
        domain: 'worldometers.info',
        href: 'https://www.worldometers.info/time/new-york-city-ny-usa/',
        snippet: 'Current local time in New York City, USA.'
      }
    ];

    extWs.send(JSON.stringify({
      type: 'search_results_result',
      requestId: reqId,
      searchIndex: 1,
      ok: true,
      label: 'Found 19 web pages',
      expectedCount: 19,
      results: mockResults
    }));

    // UI receives search_results_result
    const uiSearchResult = await waitMessage(uiWs, (m) => m.type === 'search_results_result');
    assert.equal(uiSearchResult.requestId, reqId);
    assert.equal(uiSearchResult.searchIndex, 1);
    assert.equal(uiSearchResult.ok, true);
    assert.equal(uiSearchResult.expectedCount, 19);
    assert.equal(uiSearchResult.results.length, 2);
    assert.equal(uiSearchResult.results[0].domain, 'timeandcalendars.com');

    extWs.close();
    uiWs.close();
  });
});
