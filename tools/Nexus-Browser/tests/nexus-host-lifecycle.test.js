'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST = fs.readFileSync(
  path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'nexusBrowser.js'),
  'utf8'
);
const LOADING_DOM = fs.readFileSync(
  path.join(ROOT, 'js', 'modules', 'features', 'scraper', 'ui', 'loading-indicator', 'components', 'li-dom.js'),
  'utf8'
);

test('EveOS Nexus host canonicalizes iframe URLs before deciding to reload', () => {
  assert.match(HOST, /function canonicalUrl\(value\)/);
  assert.match(HOST, /canonicalUrl\(frame\.getAttribute\('src'\) \|\| ''\)/);
  assert.match(HOST, /if \(next && current !== next\) frame\.setAttribute\('src', next\)/);
  assert.doesNotMatch(HOST, /frame\.src !== next/);
});

test('transient status failure preserves a known-running embedded Nexus workspace', () => {
  assert.match(HOST, /if \(status\?\.running === true\) render\(status, message\)/);
  assert.match(HOST, /Keeping the current workspace while Search Monitor retries/);
});


test('detached Nexus is a single-workspace handoff rather than a second persistent iframe owner', () => {
  assert.match(HOST, /workspaceControl\('snapshot', 'detach'\)/);
  assert.match(HOST, /workspaceControl\('claim', 'reattach'\)/);
  assert.match(HOST, /inline\.hidden = !running \|\| detachedOpen\(\)/);
  assert.match(HOST, /if \(detachedOpen\(\) && detachedWindow && !detachedWindow\.closed\)/);
  assert.match(HOST, /detachedWindow\.focus\(\)/);
});


test('Search Monitor retires an older embedded Nexus root and explicitly owns the current visible frame', () => {
  assert.match(HOST, /workspaceControlFor\(previous, 'standby', 'host-root-replaced'\)/);
  assert.match(HOST, /workspaceControlFor\(container, 'claim-fresh', 'host-frame-load'\)/);
  assert.match(HOST, /workspaceControl\('claim', 'host-activate'\)/);
});


test('Nexus lifecycle cold-starts Local Control only from an explicit Nexus action', () => {
  assert.match(HOST, /ensure\?\.\(\{ timeoutMs: 45000, userInitiated: true \}\)/);
});

test('Search Monitor Global Stop unloads the embedded Nexus workspace before server teardown', async () => {
  const listeners = {}, messages = [];
  const frame = {
    attributes: new Map(),
    contentWindow: { postMessage(payload) { messages.push(payload); } },
    getAttribute(name) { return this.attributes.get(name) || ''; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener() {}
  };
  const inline = { hidden: true };
  const textNodes = new Map();
  const root = {
    addEventListener() {},
    querySelector(selector) {
      if (selector === '[data-nexus-browser-frame]') return frame;
      if (selector === '[data-nexus-browser-inline]') return inline;
      if (!textNodes.has(selector)) textNodes.set(selector, { textContent: '' });
      return textNodes.get(selector);
    },
    querySelectorAll() { return []; }
  };
  const windowMock = {
    location: { href: 'file:///EveOS.html' },
    EveOSPortRegistry: { get: () => 9088, url: () => 'http://127.0.0.1:9088/' },
    EveOSLocalControl: {
      baseUrl: () => 'http://127.0.0.1:9082',
      async fetchJson() {
        return { running: true, state: 'running', url: 'http://127.0.0.1:9088/',
          extensionReady: true, appBinding: { connected: true } };
      }
    },
    addEventListener(type, handler) { listeners[type] = handler; },
    setInterval() { return 1; },
    open() {}
  };
  vm.runInNewContext(HOST, { window: windowMock, console, URL, Date }, {
    filename: 'nexusBrowser.js'
  });
  windowMock.EveOSNexusBrowser.bind(root);
  await windowMock.EveOSNexusBrowser.activate();
  assert.equal(frame.getAttribute('src'), 'http://127.0.0.1:9088/');
  listeners['eve:eveos-global-stop']({ detail: { source: 'search-monitor' } });
  assert.equal(frame.getAttribute('src'), 'about:blank');
  assert.equal(inline.hidden, true);
  assert.equal(messages.at(-1)?.action, 'standby');
  assert.match(textNodes.get('[data-nexus-browser-message]').textContent, /unloading its workspace/);
});


test('Search Monitor top-layer maintenance never reorders a connected iframe-bearing indicator', () => {
  assert.doesNotMatch(LOADING_DOM, /document\.body\.lastElementChild !== indicator/);
  assert.match(LOADING_DOM, /indicator\.parentElement !== document\.body/);
  assert.match(LOADING_DOM, /Restored #loadingIndicator as a top-level body child/);
});
