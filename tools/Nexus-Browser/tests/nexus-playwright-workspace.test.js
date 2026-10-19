'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_EVEOS_URL,
  normalizeEveosUrl,
  parseArgs,
  optionalLoopbackProbeFailure
} = require('../playwright/eveos-nexus-workspace');

test('Nexus Playwright workspace is loopback-only and targets EveOS.html', () => {
  assert.equal(normalizeEveosUrl(), DEFAULT_EVEOS_URL);
  assert.equal(normalizeEveosUrl('http://localhost:8765/EveOS.html?qa=1'), 'http://localhost:8765/EveOS.html?qa=1');
  assert.throws(() => normalizeEveosUrl('https://example.com/EveOS.html'), /loopback HTTP/);
  assert.throws(() => normalizeEveosUrl('http://127.0.0.1:8765/other.html'), /EveOS\.html/);
});

test('Nexus Playwright host arguments are bounded and explicit', () => {
  assert.deepEqual(parseArgs(['--headed', '--timeout', '45', '--duration', '120']), {
    url: DEFAULT_EVEOS_URL,
    headless: false,
    timeoutMs: 45000,
    durationMs: 120000
  });
  assert.throws(() => parseArgs(['--timeout', '2']), /5\.\.300/);
  assert.throws(() => parseArgs(['--duration', '99999']), /0\.\.86400/);
  assert.throws(() => parseArgs(['--eval', 'alert(1)']), /Unsupported/);
});

test('workspace diagnostics separate optional loopback probe noise from real browser failures', () => {
  assert.equal(optionalLoopbackProbeFailure('http://127.0.0.1:8766/api/health', 'net::ERR_ABORTED'), true);
  assert.equal(optionalLoopbackProbeFailure('http://127.0.0.1:0/api/world-book/status', 'net::ERR_UNSAFE_PORT'), true);
  assert.equal(optionalLoopbackProbeFailure('https://example.com/api/health', 'net::ERR_ABORTED'), false);
  assert.equal(optionalLoopbackProbeFailure('http://127.0.0.1:8765/EveOS.html', 'net::ERR_ABORTED'), false);
});
