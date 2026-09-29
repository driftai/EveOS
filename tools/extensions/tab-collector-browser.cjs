'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function qualifyTabPopup(context, worker, { extensionId, prefix, base, main = false }) {
  const links = [`${base}/frame?first`, `${base}/frame?second`, `${base}/frame?first`];
  const source = await worker.evaluate(url => chrome.windows.create({ url, type: 'normal' }), links);
  const other = await worker.evaluate(url => chrome.windows.create({ url, type: 'normal' }), `${base}/frame?other-window`);
  const page = await context.newPage();
  let expected = [...links];
  const network = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  try {
    if (main) {
      const placeholder = `${base}/frame?collector-ui`;
      await page.goto(placeholder);
      await worker.evaluate(async ({ url, windowId }) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.move(tab.id, { windowId, index: -1 });
      }, { url: placeholder, windowId: source.id });
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await page.getByRole('tab', { name: 'Tab URLs', exact: true }).click();
      expected.push(`chrome-extension://${extensionId}/popup.html`);
    } else {
      await page.goto(`chrome-extension://${extensionId}/${prefix}popup.html?windowId=${source.id}`);
    }
    network.length = 0;
    const ui = main ? page.frameLocator('#view-tab-collector') : page;
    await ui.locator('#collect').waitFor();
    assert.equal(await ui.locator('#urls').inputValue(), '', 'opening the popup must not collect tabs');
    assert(await ui.locator('#copy').isDisabled());
    await worker.evaluate(id => chrome.windows.update(id, { focused: true }), other.id);
    await ui.locator('#collect').click();
    await ui.locator('#status').filter({ hasText: `Collected ${expected.length} of ${expected.length}` }).waitFor();
    assert.equal(await ui.locator('#urls').inputValue(), expected.join('\n'));
    assert(!expected.some(url => url.includes('other-window')));
    const bounds = await ui.locator('#copy').boundingBox();
    assert(bounds && bounds.width > 0 && bounds.y + bounds.height <= 570, 'copy must fit within the popup');
    const scope = main ? page.frames().find(frame => frame.url().includes('modules/tab-collector/popup.html')) : page;
    await scope.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async value => { globalThis.__collectorClipboard = value; } }
    })); // Keep this synthetic fixture out of the user's real system clipboard.
    await ui.locator('#copy').click();
    assert.equal(await scope.evaluate(() => globalThis.__collectorClipboard), expected.join('\n'));
    const downloading = page.waitForEvent('download');
    await ui.locator('#export').click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), 'eveos-tab-urls.txt');
    assert.equal(fs.readFileSync(await download.path(), 'utf8'), expected.join('\n'));
    if (main) {
      await page.getByRole('tab', { name: 'Tools', exact: true }).click();
      const hub = page.frameLocator('#view-tools');
      await hub.locator('[data-open-connector][data-connector-id="tab-collector"]').click();
      await page.locator('#tab-tab-collector[aria-selected="true"]').waitFor();
      assert.equal(await ui.locator('#urls').inputValue(), expected.join('\n'), 'switching views preserves the manual collection');
      await page.getByRole('tab', { name: 'Tools', exact: true }).click();
      await page.keyboard.press('End');
      await page.locator('#tab-tab-collector[aria-selected="true"]').waitFor();
      assert.equal(await page.locator('#view-tab-collector').count(), 1, 'view switching must not duplicate tool panels');
    }
    await ui.locator('#clear').click();
    assert.equal(await ui.locator('#urls').inputValue(), '');
    assert(await ui.locator('#copy').isDisabled());
    await page.reload();
    if (main) await page.getByRole('tab', { name: 'Tab URLs', exact: true }).click();
    assert.equal(await ui.locator('#urls').inputValue(), '', 'collected URLs must not survive a new popup session');
    assert.deepEqual(network, [], 'collector UI must make no HTTP requests');
    return main ? 8 : 6;
  } finally {
    await page.close();
    await worker.evaluate(async ids => { for (const id of ids) await chrome.windows.remove(id); }, [source.id, other.id]);
  }
}
module.exports = { qualifyTabPopup };
