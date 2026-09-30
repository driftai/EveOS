'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

async function qualifyPopupCorners(page) {
  const image = await page.screenshot({ omitBackground:true });
  const alpha = await page.evaluate(async png => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), character => character.charCodeAt(0))], { type:'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    return [[0, 0], [canvas.width - 1, 0], [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1], [canvas.width / 2, 30]]
      .map(([x, y]) => context.getImageData(x, y, 1, 1).data[3]);
  }, image.toString('base64'));
  assert.deepEqual(alpha.slice(0, 4), [0, 0, 0, 0], 'popup canvas must not paint square backing pixels outside the rounded shell');
  assert.equal(alpha[4], 255, 'rounded shell must retain its opaque interior');
}

async function qualifyPopupLayout(page, resultDir) {
  await page.setViewportSize({ width:420, height:570 });
  await qualifyPopupCorners(page);
  const shell = await page.locator('#popupShell').evaluate(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { width:bounds.width, height:bounds.height, overflow:style.overflow,
      rootBackground:getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground:getComputedStyle(document.body).backgroundColor, radius:parseFloat(style.borderRadius) };
  });
  assert.deepEqual([shell.width, shell.height], [420, 570], 'popup dimensions must remain stable');
  assert(shell.overflow === 'hidden' && shell.radius >= 18 && shell.rootBackground === 'rgba(0, 0, 0, 0)'
      && shell.bodyBackground === 'rgba(0, 0, 0, 0)',
    'only the rounded shell may paint a background, not html/body canvas propagation');
  for (const [id, label, last] of [
    ['tools', 'Tools', 'main .tool-section:last-child .card:last-child'],
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
module.exports = { qualifyPopupLayout, qualifyPopupCorners };
