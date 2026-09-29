'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

async function qualifyPopupLayout(page, resultDir) {
  await page.setViewportSize({ width:420, height:570 });
  const shell = await page.locator('body').evaluate(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { width:bounds.width, height:bounds.height, radius:parseFloat(style.borderRadius), overflow:style.overflow };
  });
  assert.deepEqual([shell.width, shell.height], [420, 570], 'popup dimensions must remain stable');
  assert(shell.radius >= 12 && shell.overflow === 'hidden', 'shell must clip to its rounded surface');
  for (const [id, label, last] of [
    ['tools', 'Tools', 'main section:last-child .card:last-child'],
    ['watchfusion', 'WatchFusion', '#status'],
    ['tab-collector', 'Tab URLs', 'small']
  ]) {
    await page.getByRole('tab', { name:label, exact:true }).click();
    const panel = page.frameLocator(`#view-${id}`);
    await panel.locator('#bridge-surface-theme').waitFor({ state:'attached' });
    if (id === 'tools') await panel.locator('[data-status]').filter({ hasText:'Updated' }).waitFor();
    const frame = page.frames().find(item => item !== page.mainFrame()
      && item.url().includes(id === 'tools' ? '/hub.html' : `/modules/${id}/popup.html`));
    await frame.waitForFunction(() => getComputedStyle(document.documentElement).scrollbarWidth === 'thin');
    const metrics = await frame.evaluate(() => ({
      width:innerWidth, scrollWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.getBoundingClientRect().width,
      themed:document.querySelectorAll('#bridge-surface-theme').length,
      radius:parseFloat(getComputedStyle(document.querySelector('button')).borderRadius)
    }));
    assert(metrics.scrollWidth <= metrics.width && metrics.bodyWidth <= metrics.width, `${id}: no horizontal clipping`);
    assert.equal(metrics.themed, 1, `${id}: use one shared theme`);
    assert(metrics.radius >= 10, `${id}: controls use softened corners`);
    const viewport = await page.locator(`#view-${id}`).boundingBox();
    await page.mouse.move(viewport.x + viewport.width - 20, viewport.y + viewport.height - 40);
    await page.mouse.wheel(0, 3000);
    await frame.waitForFunction(() => {
      const root = document.scrollingElement;
      return root.scrollHeight - root.clientHeight - root.scrollTop <= 1;
    });
    const bottom = await panel.locator(last).last().boundingBox();
    await page.screenshot({ path:path.join(resultDir, `bridge-${id}.png`) });
    assert(bottom && bottom.height > 0 && bottom.y + bottom.height <= viewport.y + viewport.height + 1,
      `${id}: lower content must be reachable by scrolling ${JSON.stringify({ bottom, viewport })}`);
  }
  return 4;
}
module.exports = { qualifyPopupLayout };
