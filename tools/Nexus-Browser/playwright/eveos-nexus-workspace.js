'use strict';

const path = require('node:path');
const { launchChromiumOrConnect } = require('../../smoke/playwright-browser');

const DEFAULT_EVEOS_URL = 'http://127.0.0.1:8765/EveOS.html';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function normalizeEveosUrl(value = DEFAULT_EVEOS_URL) {
  const url = new URL(String(value || DEFAULT_EVEOS_URL));
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('Nexus Playwright workspace accepts only loopback HTTP EveOS URLs.');
  }
  if (!/\/EveOS\.html$/i.test(url.pathname)) {
    throw new Error('Nexus Playwright workspace must open the EveOS.html entrypoint.');
  }
  url.hash = '';
  return url.toString();
}

function parseArgs(argv = []) {
  const options = { url: DEFAULT_EVEOS_URL, headless: true, timeoutMs: 90000, durationMs: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--headed') options.headless = false;
    else if (token === '--headless') options.headless = true;
    else if (['--url', '--timeout', '--duration'].includes(token)) {
      const value = argv[++index];
      if (value == null || String(value).startsWith('--')) throw new Error(`${token} requires a value.`);
      if (token === '--url') options.url = value;
      else if (token === '--timeout') options.timeoutMs = Number(value) * 1000;
      else options.durationMs = Number(value) * 1000;
    } else throw new Error(`Unsupported Nexus Playwright option ${token}.`);
  }
  options.url = normalizeEveosUrl(options.url);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 5000 || options.timeoutMs > 300000) {
    throw new Error('--timeout must be 5..300 seconds.');
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs < 0 || options.durationMs > 86400000) {
    throw new Error('--duration must be 0..86400 seconds.');
  }
  return options;
}

function boundedDiagnostics(limit = 20) {
  const records = [];
  const ignored = [];
  return {
    records, ignored,
    add(kind, text) {
      records.push({ at: new Date().toISOString(), kind, text: String(text || '').slice(0, 1000) });
      if (records.length > limit) records.splice(0, records.length - limit);
    },
    ignore(kind, text) {
      ignored.push({ at: new Date().toISOString(), kind, text: String(text || '').slice(0, 1000) });
      if (ignored.length > limit) ignored.splice(0, ignored.length - limit);
    }
  };
}

function optionalLoopbackProbeFailure(url, errorText) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return false; }
  return LOOPBACK_HOSTS.has(parsed.hostname)
    && /^\/api\/(?:health|status|control-plane\/health|world-book\/status)$/i.test(parsed.pathname)
    && ['net::ERR_ABORTED', 'net::ERR_UNSAFE_PORT'].includes(String(errorText || ''));
}

async function waitForSecondFrame(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function mountNexusWorkspace(page, { timeoutMs = 90000 } = {}) {
  await page.waitForFunction(() => !!(
    window.EveOSSearchMonitorAiHome
    && window.EveOSAgentNexus
    && window.EveOSServiceChatBridge
    && window.SearchMonitorBoot
  ), null, { timeout: timeoutMs });

  const monitor = page.locator('#loadingIndicator');
  const home = page.locator('#loadingIndicator #gemini-ui-root');
  if (!await home.isVisible()) {
    await monitor.waitFor({ state: 'attached', timeout: timeoutMs });
    await page.evaluate(() => {
      if (typeof window.SearchMonitorBoot?.expand !== 'function') {
        throw new Error('Search Monitor expand capability is unavailable.');
      }
      window.SearchMonitorBoot.expand();
    });
  }
  await home.waitFor({ state: 'visible', timeout: timeoutMs });

  const workspaceButton = page.locator('[data-gemini-monitor-view-btn="full"]');
  if (await workspaceButton.isVisible()) await workspaceButton.click({ timeout: timeoutMs });

  const agents = page.locator('[data-ai-provider="agents"]');
  await agents.waitFor({ state: 'attached', timeout: timeoutMs });
  if (!await agents.evaluate((element) => element.open === true)) {
    await agents.locator(':scope > summary').click({ timeout: timeoutMs });
  }

  await page.locator('[data-agent-nexus-view="nexus-browser"]').click({ timeout: timeoutMs });
  const frame = page.locator('[data-nexus-browser-frame]');
  await frame.waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForFunction(() => {
    const iframe = document.querySelector('[data-nexus-browser-frame]');
    const source = String(iframe?.getAttribute('src') || '');
    return /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(source);
  }, null, { timeout: timeoutMs });
  await page.evaluate(() => window.EveOSServiceChatBridge.ensureConnected());
  await page.waitForFunction(() => window.EveOSServiceChatBridge?.isRegistered?.() === true, null, { timeout: timeoutMs });
  await waitForSecondFrame(page);

  return page.evaluate(() => ({
    workspaceId: window.EveOSServiceChatBridge.workspaceId,
    targets: Array.from(window.EveOSServiceChatBridge.targets || []),
    frameUrl: document.querySelector('[data-nexus-browser-frame]')?.src || '',
    registered: window.EveOSServiceChatBridge.isRegistered()
  }));
}

async function openNexusWorkspace(options = {}) {
  const settings = { url: DEFAULT_EVEOS_URL, headless: true, timeoutMs: 90000, ...options };
  settings.url = normalizeEveosUrl(settings.url);
  const diagnostics = boundedDiagnostics();
  const launched = await launchChromiumOrConnect({ headless: settings.headless });
  const page = await launched.browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', (error) => diagnostics.add('pageerror', error?.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/^Failed to load resource: net::ERR_(?:ABORTED|UNSAFE_PORT)$/.test(message.text())) diagnostics.ignore('console-probe', message.text());
    else diagnostics.add('console', message.text());
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText || '';
    const text = `${request.method()} ${request.url()} ${errorText}`;
    if (optionalLoopbackProbeFailure(request.url(), errorText)) diagnostics.ignore('optional-loopback-probe', text);
    else diagnostics.add('requestfailed', text);
  });
  try {
    await page.goto(settings.url, { waitUntil: 'domcontentloaded', timeout: settings.timeoutMs });
    const workspace = await mountNexusWorkspace(page, settings);
    return {
      browser: launched.browser,
      page,
      mode: launched.mode,
      workspace,
      diagnostics,
      async close() {
        await page.close().catch(() => {});
        await launched.browser.close().catch(() => {});
      }
    };
  } catch (error) {
    await page.close().catch(() => {});
    await launched.browser.close().catch(() => {});
    error.diagnostics = diagnostics.records;
    throw error;
  }
}

module.exports = {
  DEFAULT_EVEOS_URL,
  normalizeEveosUrl,
  parseArgs,
  mountNexusWorkspace,
  openNexusWorkspace,
  optionalLoopbackProbeFailure,
  waitForSecondFrame,
  evidenceDir: path.resolve(__dirname, '..', '..', '..', 'data', 'runtime', 'smoke-results', 'nexus-playwright-workspace')
};
