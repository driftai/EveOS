'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

async function qualifyCollapses(page, worker, resultDir) {
  await page.getByRole('tab', { name:'Tools', exact:true }).click();
  let hub = page.frameLocator('#view-tools');
  await hub.locator('[data-status]:not(:empty)').waitFor();
  const card = id => hub.locator(`[data-collapse="service:${id}"]`);
  for (const id of ['eveos', 'nexus-browser', 'watchfusion']) {
    assert.equal(await card(id).evaluate(node => node.open), false, 'unconfigured service actions start folded');
    assert(await card(id).locator('button').isHidden(), 'folded cards must hide their actions');
    await card(id).locator('summary').click();
    assert(await card(id).locator('button').isVisible());
  }
  await card('nexus-browser').locator('summary').click();
  await hub.locator('[data-collapse="section:services"] > summary').click();
  assert(await card('eveos').locator('button').isHidden(), 'section collapse must hide expanded child actions');
  await hub.locator('[data-collapse="section:connectors"] > summary').click();
  await hub.locator('[data-collapse="setup"] > summary').click();
  await hub.getByRole('button', { name:'Refresh', exact:true }).click();
  await hub.locator('[data-status]').filter({ hasText:'Updated' }).waitFor();
  assert.equal(await card('eveos').evaluate(node => node.open), true, 'refresh preserves child expansion');
  assert.equal(await card('nexus-browser').evaluate(node => node.open), false, 'refresh preserves child collapse');
  const expected = { setup:true, 'section:services':false, 'section:connectors':false,
    'service:eveos':true, 'service:nexus-browser':false, 'service:watchfusion':true };
  await worker.evaluate(async expected => {
    const prefix = 'eveosBridgeExpandedV1:';
    for (let attempt = 0; attempt < 40; attempt++) {
      const saved = await chrome.storage.local.get(Object.keys(expected).map(key => prefix + key));
      if (Object.entries(expected).every(([key, value]) => saved[prefix + key] === value)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Collapse preferences were not persisted');
  }, expected);
  await page.reload();
  hub = page.frameLocator('#view-tools');
  await hub.locator('[data-status]').filter({ hasText:'Updated' }).waitFor();
  for (const [key, open] of Object.entries(expected)) {
    assert.equal(await hub.locator(`[data-collapse="${key}"]`).evaluate(node => node.open), open,
      `${key}: reopening must restore the exact preference`);
  }
  await page.screenshot({ path:path.join(resultDir, 'bridge-remembered-collapses.png') });
  await hub.locator('[data-collapse="section:services"] > summary').focus();
  await page.keyboard.press('Space');
  assert(await card('eveos').locator('button').isVisible(), 'keyboard expansion must expose actions');
  await hub.locator('[data-collapse="section:connectors"] > summary').click();
  await hub.locator('[data-collapse="setup"] > summary').click();
  await page.getByRole('tab', { name:'WatchFusion', exact:true }).click();
  const watch = page.frameLocator('#view-watchfusion');
  await watch.locator('details > summary').click();
  await worker.evaluate(async () => {
    const key = 'eveosBridgeExpandedV1:panel:watchfusion:setup-embedded-players';
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await chrome.storage.local.get(key))[key] === true) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('WatchFusion collapse preference not saved');
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#tab-watchfusion')?.getAttribute('aria-selected') === 'true');
  await watch.locator('details[open]').waitFor();
  assert.equal(await page.getByRole('tab', { name:'WatchFusion', exact:true }).getAttribute('aria-selected'), 'true',
    'reopening Bridge must restore its last selected tool tab');
  assert.equal(await watch.locator('#pairing').inputValue(), '', 'layout persistence must not save pairing inputs');
  return 6;
}
module.exports = { qualifyCollapses };
