'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const { audit, build } = require('./assemble.cjs');
const { qualifyTabPopup } = require('./tab-collector-browser.cjs');
const ROOT = path.resolve(__dirname, '../..');

const mediaHtml = iframe => `<!doctype html><html><body style="margin:0;height:2200px;background:#802050">
<aside>Fixture sidebar must stay outside the selected media.</aside>${iframe ?
  '<iframe style="width:600px;height:420px" src="http://localhost:PORT/frame"></iframe>' :
  '<video id="video" autoplay muted style="width:600px;height:420px"></video><script>const c=document.createElement("canvas");c.width=640;c.height=360;const ctx=c.getContext("2d");ctx.fillStyle="#00c480";ctx.fillRect(0,0,640,360);video.srcObject=c.captureStream(5);</script>'}
</body></html>`;

async function qualifyBrowser() {
  audit(); // Reject a stale tracked manifest before preparing ignored packaging assets.
  build();
  audit({ assets: true });
  const resultDir = path.join(ROOT, 'data/runtime/smoke-results/extension-browser');
  fs.mkdirSync(resultDir, { recursive: true });
  const fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': req.url === '/health' ? 'application/json' : 'text/html' });
    res.end(req.url === '/health' ? '{"ok":true}' : mediaHtml(req.url !== '/frame').replace('PORT', fixture.address().port));
  });
  const sockets = [], messages = [];
  const wss = new WebSocketServer({ server: fixture, path: '/ws' });
  wss.on('connection', socket => { sockets.push(socket); socket.on('message', value => messages.push(JSON.parse(value))); });
  await new Promise(resolve => fixture.listen(0, '0.0.0.0', resolve));
  const port = fixture.address().port;
  let pass = 0;
  const diagnostics = [];
  const variants = [
    { id: 'official', source: 'extension', media: 'modules/watchfusion/', nexus: 'modules/nexus-browser/' },
    { id: 'watchfusion-standalone', source: 'tools/WatchFusion/browser-extension', media: '', nexus: null },
    { id: 'nexus-standalone', source: 'tools/Nexus-Browser/extension', media: null, nexus: '' },
    { id: 'collector-standalone', source: 'tools/Tab-Collector/extension', media: null, nexus: null }
  ];
  try {
    for (const variant of variants) {
      const temp = fs.mkdtempSync(path.join(resultDir, variant.id + '-'));
      const packageDir = path.join(temp, 'package');
      fs.cpSync(path.join(ROOT, variant.source), packageDir, { recursive: true });
      if (variant.nexus != null) {
        const config = path.join(packageDir, variant.nexus, 'runtime-config.js');
        const source = fs.readFileSync(config, 'utf8');
        assert(/const port = \d+;/.test(source));
        fs.writeFileSync(config, source.replace(/const port = \d+;/, `const port = ${port};`));
      }
      // Only the qualification package receives this localhost port override.
      const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
        channel: 'chromium', headless: true,
        viewport: { width: 1000, height: 760 },
        args: [`--disable-extensions-except=${packageDir}`, `--load-extension=${packageDir}`]
      });
      context.on('weberror', error => diagnostics.push(`${variant.id}: ${error.error().message}`));
      let page;
      try {
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extensionId = new URL(worker.url()).hostname;
        await worker.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
        if (variant.id === 'official') {
          const descriptors = await worker.evaluate(() => EveOSExtensionModules.describe());
          assert.deepEqual(descriptors.map(value => value.id).sort(), ['nexus-browser', 'tab-collector', 'watchfusion']);
          assert(descriptors.every(value => value.integration === 'included'));
          const hub = await context.newPage();
          await hub.goto(`chrome-extension://${extensionId}/hub.html`);
          await hub.getByText('INCLUDED', { exact: true }).first().waitFor();
          assert.equal(await hub.getByText('INCLUDED', { exact: true }).count(), 3);
          await hub.locator('[data-open-connector][data-connector-id="watchfusion"]').evaluate(el => {
            const r = el.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('Hidden tool action');
          });
          await hub.close(); pass += 2;
          const popup = await context.newPage();
          await popup.goto(`chrome-extension://${extensionId}/popup.html`);
          await popup.getByRole('tab', { name: 'WatchFusion', exact: true }).click();
          await popup.frameLocator('#view-watchfusion').locator('#connect').waitFor();
          assert((await popup.locator('#view-watchfusion').getAttribute('src')).startsWith('modules/watchfusion/popup.html?windowId='));
          assert.equal(await popup.locator('body').evaluate(el => el.getBoundingClientRect().height), 570);
          await popup.screenshot({ path: path.join(resultDir, 'bridge-popup.png') });
          await popup.close(); pass++;
        }
        if (variant.nexus != null) {
          const patterns = await worker.evaluate(() => BrowserAiBridgeDexProviderControlBoot.providerPatterns());
          assert(patterns.length > 0 && patterns.includes('https://chatgpt.com/*'), 'Dex must discover providers in either package layout');
          pass += 1;
          const initialMessages = messages.length;
          await worker.evaluate(async () => { await connect(); await publishTabs({ force: true }); });
          await worker.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
          assert(sockets.length > 0);
          assert(messages.slice(initialMessages).some(value => value.type === 'tabs_update'));
          page = await context.newPage();
          await page.goto(`http://127.0.0.1:${port}/frame`);
          await worker.evaluate(async url => {
            const [tab] = await chrome.tabs.query({ url });
            await safeExecuteScript({ target: { tabId: tab.id }, files: ['content/provider-adapter-revision.js'] });
          }, `http://127.0.0.1:${port}/frame`);
          await page.close(); pass += 2;
        }
        if (variant.media != null) {
          page = await context.newPage();
          await page.goto(`http://127.0.0.1:${port}/media`);
          await page.frameLocator('iframe').locator('#video').waitFor();
          await page.waitForFunction(() => document.querySelector('iframe').contentWindow != null);
          await worker.evaluate(async url => {
            const [tab] = await chrome.tabs.query({ url });
            sourceTab = tab.id;
            await chrome.storage.session.set({ sourceTab });
            await inject(sourceTab);
          }, `http://127.0.0.1:${port}/media`);
          const frame = page.frames().find(value => value.url().includes('/frame'));
          await frame.waitForFunction(() => document.querySelector('video').style.position === 'fixed');
          const before = await frame.locator('video').boundingBox();
          await page.evaluate(() => scrollTo(0, 1000));
          await frame.evaluate(() => scrollTo(0, 1000));
          const after = await frame.locator('video').boundingBox();
          assert.deepEqual(after, before);
          await worker.evaluate(() => new Promise((resolve, reject) => {
            const began = Date.now();
            const check = () => controlFrameId !== 0 ? resolve() : Date.now() - began > 3000
              ? reject(new Error('No embedded media control frame')) : setTimeout(check, 50);
            check();
          }));
          const combined = await worker.evaluate(() => {
            const value = [...frameSamples.values()].find(sample => sample?.hasMedia && !sample.topFrame);
            return combinedSample(value.frameId, value).rect;
          });
          assert(combined.width > 0 && combined.height > 0 && combined.height < 1);
          await worker.evaluate(() => chrome.tabs.sendMessage(sourceTab, { type: 'source-control', action: 'pause' }, { frameId: controlFrameId }));
          await frame.waitForFunction(() => document.querySelector('video').paused);
          await worker.evaluate(() => WatchFusionMediaLink.stop());
          assert.equal(await frame.locator('video').getAttribute('style'), 'width:600px;height:420px');
          assert.equal(await page.locator('iframe').getAttribute('style'), 'width:600px;height:420px');
          await page.close(); pass += 4;
        }
        if (variant.id === 'official' || variant.id === 'collector-standalone') {
          pass += await qualifyTabPopup(context, worker, { extensionId,
            prefix: variant.id === 'official' ? 'modules/tab-collector/' : '',
            base: `http://127.0.0.1:${port}`, main: variant.id === 'official' });
        }
      } catch (error) {
        if (page && !page.isClosed()) await page.screenshot({ path: path.join(resultDir, `${variant.id}-failure.png`) }).catch(() => {});
        throw new Error(`${variant.id}: ${error.message}`);
      } finally { await context.close(); }
    }
    assert.deepEqual(diagnostics, []);
    fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify({ pass, status: 'PASS', qualification: 'isolated profiles / synthetic media / Nexus port override' }, null, 2));
    return pass;
  } catch (error) {
    fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify({ pass, status: 'FAIL', error: error.stack, diagnostics }, null, 2));
    throw error;
  } finally {
    sockets.forEach(socket => socket.terminate());
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => fixture.close(resolve));
  }
}
module.exports = { qualifyBrowser };
