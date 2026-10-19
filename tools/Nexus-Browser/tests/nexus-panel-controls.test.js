const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('provider allowance data is hidden behind a compact toolbar and major sections are disclosures', () => {
  assert.match(INDEX, /id="nexusProviderUsageToggle"[^>]*aria-expanded="false"/);
  assert.match(INDEX, /id="nexusProviderUsagePanel"[^>]*hidden/);
  assert.match(INDEX, /id="nexusCodexQuota"/);
  assert.match(INDEX, /id="nexusCodexBurn"/);
  assert.ok((INDEX.match(/data-nexus-collapsible/g) || []).length >= 5);
  assert.match(INDEX, /nexus-panel-controls\.js[\s\S]*codex-quota-ui\.js/);
});

test('real browser buttons reveal usage and collapse only visible workspace sections', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button id="nexusProviderUsageToggle" aria-expanded="false"></button>
    <button id="nexusCollapsePanels"></button><button id="nexusExpandPanels"></button>
    <div id="nexusProviderUsagePanel" hidden>usage</div>
    <div id="base"><details id="basePanel" data-nexus-collapsible open><summary>Base</summary></details></div>
    <div id="dex" hidden><details id="dexPanel" data-nexus-collapsible open><summary>Dex</summary></details></div>`);
  await page.addScriptTag({ path: path.join(ROOT, 'public', 'nexus-panel-controls.js') });

  await page.locator('#nexusProviderUsageToggle').press('Space');
  assert.equal(await page.locator('#nexusProviderUsagePanel').isVisible(), true);
  assert.equal(await page.locator('#nexusProviderUsageToggle').getAttribute('aria-expanded'), 'true');
  await page.locator('#nexusCollapsePanels').click();
  assert.equal(await page.locator('#basePanel').evaluate((node) => node.open), false);
  assert.equal(await page.locator('#dexPanel').evaluate((node) => node.open), true);
  await page.locator('#nexusExpandPanels').click();
  assert.equal(await page.locator('#basePanel').evaluate((node) => node.open), true);
});
