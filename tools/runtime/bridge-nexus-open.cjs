'use strict';
/* Opt-in live proof: explicit Open may start Nexus; never dispatches a room/prompt. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require('playwright');
const { build } = require('../extensions/assemble.cjs');
const ROOT = path.resolve(__dirname, '../..');
async function main() {
  build();
  const config = require('../Nexus-Browser/extension/runtime-config.js');
  const { configureHeadedServices } = await import('./search-monitor-runtime.shared.mjs');
  await configureHeadedServices(['nexusBrowser']);
  const before = await fetch(`${config.controlOrigin}/api/nexus-browser/status`).then(response => response.json());
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-bridge-live-'));
  const errors = []; let context;
  const artifact = path.join(ROOT, 'data/runtime/smoke-results/bridge-nexus-live.json');
  try {
    const extension = path.join(ROOT, 'extension');
    context = await chromium.launchPersistentContext(profile, { channel:'chromium', headless:true,
      args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    assert.equal(extensionId, 'doioapjnmiknkdigmdoapoahlhcaikag');
    const popup = await context.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const hub = popup.frameLocator('#view-tools');
    await hub.locator('[data-status]').filter({ hasText:'Updated' }).waitFor();
    const card = hub.locator('[data-collapse="service:nexus-browser"]');
    if (!await card.evaluate(node => node.open)) await card.locator('summary').click();
    const opened = context.waitForEvent('page', { timeout:30000 });
    await card.locator('[data-open-service]').click();
    const dashboard = await opened;
    await dashboard.waitForLoadState('domcontentloaded');
    assert(dashboard.url().startsWith(config.httpOrigin + '/'));
    const health = await fetch(config.healthUrl).then(response => response.json());
    assert(health.ok === true && health.service === 'eveos-nexus-browser');
    const after = await fetch(`${config.controlOrigin}/api/nexus-browser/status`).then(response => response.json());
    assert(after.running === true && after.extensionConnected === true);
    assert.deepEqual(errors, []);
    const result = { status:'PASS', checkedAt:new Date().toISOString(), extensionId,
      previouslyRunning:before.running, running:after.running, extensionConnected:after.extensionConnected,
      supervisorPid:after.supervisorPid, qualification:'real control/runtime; isolated popup pointer Open; no provider/room dispatch' };
    fs.mkdirSync(path.dirname(artifact), { recursive:true }); fs.writeFileSync(artifact, JSON.stringify(result, null, 2));
    console.log(`BRIDGE_NEXUS_LIVE_OK started=${!before.running} pid=${after.supervisorPid} artifact=${artifact}`);
  } catch (error) {
    fs.mkdirSync(path.dirname(artifact), { recursive:true });
    fs.writeFileSync(artifact, JSON.stringify({ status:'FAIL', error:error.message, errors }, null, 2));
    throw error;
  } finally {
    await context?.close();
    if (!path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe temporary profile path');
    fs.rmSync(profile, { recursive:true });
  }
}
main().catch(error => { console.error(`BRIDGE_NEXUS_LIVE_FAILED: ${error.message}`); process.exitCode = 1; });
