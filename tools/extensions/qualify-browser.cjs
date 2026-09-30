'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const { audit, build } = require('./assemble.cjs');
const { qualifyTabPopup } = require('./tab-collector-browser.cjs');
const { qualifyPopupLayout } = require('./bridge-popup-layout.cjs');
const { qualifyCollapses } = require('./bridge-collapse-browser.cjs');
const ROOT = path.resolve(__dirname, '../..');

const mediaHtml = iframe => `<!doctype html><html><body style="margin:0;height:2200px;background:#802050">
<aside>Fixture sidebar must stay outside the selected media.</aside>${iframe ?
  '<iframe data-comments style="width:850px;height:650px" src="http://localhost:PORT/comments"></iframe><iframe data-player style="width:600px;height:420px" src="http://localhost:PORT/frame"></iframe>' :
  '<video id="video" autoplay muted style="width:600px;height:420px"></video><script>const c=document.createElement("canvas");c.width=640;c.height=360;const ctx=c.getContext("2d");ctx.fillStyle="#00c480";ctx.fillRect(0,0,640,360);video.srcObject=c.captureStream(5);</script>'}
</body></html>`;
const componentHtml = `<!doctype html><html><body style="margin:0;background:#101820"><script>
window.mediaCalls=[];
class StrmFixture extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<iframe aria-label="Fixture episode" style="width:100%;height:100%;border:0"></iframe>';}
  connectedCallback(){this.style.cssText='display:block;width:800px;height:450px';
    this.dispatchEvent(new CustomEvent('strmcx-state-change',{detail:{state:'playing'}}));
    this.dispatchEvent(new CustomEvent('strmcx-time-update',{detail:{currentTime:12,duration:120}}));}
  play(){mediaCalls.push('play')} pause(){mediaCalls.push('pause')} togglePlay(){mediaCalls.push('toggle')}
  seek(value){mediaCalls.push('seek:'+value)} setVolume(value){mediaCalls.push('volume:'+value)}
  setPlaybackRate(value){mediaCalls.push('rate:'+value)} nextEpisode(){mediaCalls.push('next')} previousEpisode(){mediaCalls.push('prev')}
}
customElements.define('strmcx-embed',StrmFixture);
</script><strmcx-embed></strmcx-embed></body></html>`;

async function qualifyBrowser() {
  audit(); // Reject a stale tracked manifest before preparing ignored packaging assets.
  build();
  audit({ assets: true });
  const resultDir = path.join(ROOT, 'data/runtime/smoke-results/extension-browser');
  fs.mkdirSync(resultDir, { recursive: true });
  const fixture = http.createServer((req, res) => {
    const health = req.url === '/health' || req.url === '/api/health';
    const diagnosticsRequest = req.url === '/diagnostics';
    res.writeHead(200, { 'Content-Type': health || diagnosticsRequest ? 'application/json' : 'text/html' });
    res.end(health ? '{"ok":true,"service":"eveos-nexus-browser","app":"WatchFusion"}'
      : diagnosticsRequest ? '{"ok":true,"extensionConnected":true,"dexUiConnected":true,"uiClients":2,"onlineTargets":3,"localTargets":1,"dexRooms":4,"recoveryRooms":0,"serverSessionId":"fixture-session","savedAt":"2026-09-30T00:00:00Z","controlPlane":{}}'
      : req.url === '/component' ? componentHtml
      : req.url === '/comments'
      ? '<!doctype html><html><body>Comments are not playable media.</body></html>'
      : mediaHtml(req.url !== '/frame').replaceAll('PORT', fixture.address().port));
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
        fs.writeFileSync(config, source.replace(/const port = \d+;/, `const port = ${port};`)
          .replace(/const controlPort = \d+;/, `const controlPort = ${port};`));
      }
      if (variant.id === 'official') {
        const file = path.join(packageDir, 'core/catalog.js');
        const catalog = require('../../extension/core/catalog.js');
        let source = fs.readFileSync(file, 'utf8');
        for (const id of ['nexus-browser', 'watchfusion']) {
          source = source.replaceAll(new URL(catalog.services.find(item => item.id === id).url).origin, `http://127.0.0.1:${port}`);
        }
        fs.writeFileSync(file, source);
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
          assert.deepEqual(descriptors.find(value => value.id === 'watchfusion').actions, []);
          assert.deepEqual(descriptors.find(value => value.id === 'nexus-browser').actions, []);
          const hub = await context.newPage();
          await hub.goto(`chrome-extension://${extensionId}/hub.html`);
          await hub.getByText('INCLUDED', { exact: true }).first().waitFor();
          assert.equal(await hub.getByText('INCLUDED', { exact: true }).count(), 3);
          await hub.locator('[data-collapse^="connector:watchfusion:"] > summary').click();
          await hub.locator('[data-open-connector][data-connector-id="watchfusion"]').evaluate(el => {
            const r = el.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('Hidden tool action');
          });
          await hub.locator('[data-collapse^="connector:nexus-browser:"] > summary').click();
          assert.equal(await hub.getByRole('button', { name:'Open Nexus', exact:true }).count(), 0);
          await hub.close(); pass += 3;
          const popup = await context.newPage();
          await popup.goto(`chrome-extension://${extensionId}/popup.html`);
          await popup.getByRole('tab', { name: 'Nexus', exact: true }).click();
          const nexus = popup.frameLocator('#view-nexus-browser');
          await nexus.locator('#state').filter({ hasText:'ONLINE' }).waitFor();
          assert.equal(await nexus.locator('#providers').textContent(), '3');
          assert((await popup.locator('#view-nexus-browser').getAttribute('src')).startsWith('modules/nexus-browser/popup.html?windowId='));
          await popup.getByRole('tab', { name:'Tools', exact:true }).click();
          const tools = popup.frameLocator('#view-tools');
          await tools.locator('[data-collapse^="connector:nexus-browser:"] > summary').click();
          await tools.locator('[data-open-connector][data-connector-id="nexus-browser"]').click();
          await popup.waitForFunction(() => document.querySelector('#tab-nexus-browser')?.getAttribute('aria-selected') === 'true');
          await popup.getByRole('tab', { name: 'WatchFusion', exact: true }).click();
          await popup.frameLocator('#view-watchfusion').locator('#connect').waitFor();
          assert(await popup.frameLocator('#view-watchfusion').locator('#stop').isHidden());
          assert.equal(await popup.frameLocator('#view-watchfusion').locator('#openFolder').count(), 0);
          assert((await popup.locator('#view-watchfusion').getAttribute('src')).startsWith('modules/watchfusion/popup.html?windowId='));
          assert.equal(await popup.locator('body').evaluate(el => el.getBoundingClientRect().height), 570);
          await popup.screenshot({ path: path.join(resultDir, 'bridge-popup.png') });
          pass += await qualifyPopupLayout(popup, resultDir);
          pass += await qualifyCollapses(popup, worker, resultDir);
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
          const mediaPopup = await context.newPage();
          await mediaPopup.goto(`chrome-extension://${extensionId}/${variant.media}popup.html`);
          assert(await mediaPopup.locator('#stop').isHidden());
          assert.equal(await mediaPopup.locator('#openFolder').count(), 0);
          await mediaPopup.close(); pass++;
          page = await context.newPage();
          await page.goto(`http://127.0.0.1:${port}/media`);
          await page.frameLocator('iframe[data-player]').locator('#video').waitFor();
          await page.waitForFunction(() => document.querySelector('iframe').contentWindow != null);
          await worker.evaluate(async url => {
            const [tab] = await chrome.tabs.query({ url });
            sourceTab = tab.id;
            await chrome.storage.session.set({ sourceTab });
            await inject(sourceTab);
          }, `http://127.0.0.1:${port}/media`);
          assert.equal(await worker.evaluate(async () => (await WatchFusionMediaLink.status()).linked), false,
            'a persisted tab without active offscreen capture must not report sharing');
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
          assert.equal(await page.locator('iframe[data-comments]').evaluate(el => el.style.position), '');
          await worker.evaluate(() => chrome.tabs.sendMessage(sourceTab, { type: 'source-control', action: 'pause' }, { frameId: controlFrameId }));
          await frame.waitForFunction(() => document.querySelector('video').paused);
          await worker.evaluate(() => WatchFusionMediaLink.stop());
          assert.equal(await frame.locator('video').getAttribute('style'), 'width:600px;height:420px');
          assert.equal(await page.locator('iframe[data-player]').getAttribute('style'), 'width:600px;height:420px');
          await page.close();
          page = await context.newPage();
          await page.goto(`http://127.0.0.1:${port}/component`);
          await worker.evaluate(async url => {
            const [tab] = await chrome.tabs.query({ url }); sourceTab = tab.id;
            await chrome.storage.session.set({ sourceTab }); await inject(sourceTab);
          }, `http://127.0.0.1:${port}/component`);
          await worker.evaluate(() => new Promise((resolve, reject) => {
            const began = Date.now();
            const check = () => frameSamples.get(0)?.hasMedia ? resolve() : Date.now() - began > 3000
              ? reject(new Error('Web-component media adapter did not become playable')) : setTimeout(check, 50);
            check();
          }));
          assert.equal(await page.locator('strmcx-embed').evaluate(el => el.style.position), 'fixed');
          await worker.evaluate(() => chrome.tabs.sendMessage(sourceTab, { type:'source-control', action:'pause' }, { frameId:0 }));
          await page.waitForFunction(() => window.mediaCalls.includes('pause'));
          await worker.evaluate(() => WatchFusionMediaLink.stop());
          const restored = await page.locator('strmcx-embed').evaluate(element => ({
            position:element.style.position, width:element.style.width, height:element.style.height
          }));
          assert.deepEqual(restored, { position:'', width:'800px', height:'450px' });
          await page.close(); pass += 6;
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
