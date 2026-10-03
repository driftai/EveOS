#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const modulePath = path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'nexusBrowser.js');
const agentPath = path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'agentNexus.js');
const manifestPath = path.join(ROOT, 'js', 'config', 'manifest', 'scripts.parts', '13-gemini.js');
const cssFacadePath = path.join(ROOT, 'css', 'modules', 'gemini', 'gemini_link_surfaces.css');
const cssPath = path.join(ROOT, 'css', 'modules', 'gemini', 'gemini_link_surfaces.nexus-browser.css');
const source = fs.readFileSync(modulePath, 'utf8');
const agentSource = fs.readFileSync(agentPath, 'utf8');
const manifest = fs.readFileSync(manifestPath, 'utf8');
const cssFacade = fs.readFileSync(cssFacadePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const detachedSource = fs.readFileSync(path.join(ROOT, 'tools', 'Nexus-Browser', 'public', 'detached-state.js'), 'utf8');
const nexusIndex = fs.readFileSync(path.join(ROOT, 'tools', 'Nexus-Browser', 'public', 'index.html'), 'utf8');
const requests = [];
const listeners = {};
const rootMock = {
  addEventListener(type, handler) { listeners[type] = handler; },
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
const windowMock = {
  EveOSPortRegistry: { get(name) { return name === 'NEXUS_BROWSER_PORT' ? 9088 : 0; }, url() { return 'http://127.0.0.1:9088'; } },
  EveOSLocalControl: {
    baseUrl() { return 'http://127.0.0.1:9082'; },
    async ensure() { return { ok: true }; },
    async fetchJson(url, options) {
      requests.push({ url, options });
      return { ok: true, state: 'stopped', running: false, dependenciesReady: true, extensionReady: true, port: 9088 };
    }
  },
  open() {},
  addEventListener() {},
  setTimeout,
  clearTimeout
};
const context = { window: windowMock, console, setTimeout, clearTimeout, AbortController };
vm.runInNewContext(source, context, { filename: modulePath });

const markup = windowMock.EveOSNexusBrowser.markup();
assert.match(markup, /data-agent-tool-id="nexus-browser"/);
assert.match(markup, /data-nexus-browser-action="(?:setup|start|stop|extension|detached)"/);
assert.match(markup, /data-nexus-browser-frame/);
assert.match(markup, /data-nexus-browser-detached>Closed/);
assert.match(source, /popup=yes,width=1280,height=900/);
assert.match(source, /eveosDetached/);
assert.match(source, /Date\.now\(\) - detachedSeenAt < DETACHED_HEARTBEAT_MS/,
  'Detached-open state must expire without child heartbeats');
assert.match(source, /!running && detachedWindow && !detachedWindow\.closed\) closeDetached\(\)/,
  'Stopping Nexus must close its detached popup instead of leaving a stale window');
assert.match(nexusIndex, /detached-state\.js/);
assert.match(detachedSource, /eveos:nexus-detached-state/);
assert.match(detachedSource, /beforeunload/);
assert.doesNotMatch(source, /window\.open\([^\n]*'_blank'/, 'Detached Nexus must not open as a generic browser tab');
assert.doesNotMatch(source, /localStorage|sessionStorage|\/api\/nexus-browser\/start[^']*activate/);
assert.match(source, /frame\.setAttribute\('src', 'about:blank'\)/,
  'Stop must unload the embedded runtime through the attribute used by its canonical URL check');
windowMock.EveOSNexusBrowser.bind(rootMock);
windowMock.EveOSNexusBrowser.activate().then(() => {
  assert.equal(requests.length, 1, 'Opening Nexus Browser must perform one passive status request');
  assert.match(requests[0].url, /\/api\/nexus-browser\/status$/);
  assert.equal(requests[0].options, null);
  windowMock.EveOSTloChat = { markup: () => '<div data-agent-id="tlo"></div>', bind() {}, activate() {} };
  vm.runInNewContext(agentSource, context, { filename: agentPath });
  assert.match(windowMock.EveOSAgentNexus.markup(), /Browser transport & Dex/);
  assert.ok(manifest.indexOf('nexusBrowser.js') < manifest.indexOf('agentNexus.js'), 'Nexus Browser load order drifted');
  assert.match(cssFacade, /gemini_link_surfaces\.nexus-browser\.css/);
  assert.match(css, /@media \(max-width: 620px\)/, 'Mobile layout is missing');
  console.log('NEXUS_BROWSER_SURFACE_SMOKE_OK');
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
