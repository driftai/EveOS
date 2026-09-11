import { test, expect } from '@playwright/test';

test.describe('WatchFusion Nuvio player dialog compatibility', () => {
  test('subtitle, audio, speed and source overlays reserve the playbar area', async ({ page }) => {
    await page.goto('/');
    await page.click('#headerToggleBtn');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const frameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await frameElement.contentFrame();

    await expect.poll(async () => nuvioFrame.evaluate(() => {
      return document.documentElement.classList.contains('watchfusion-nuvio') &&
        document.getElementById('__watchfusion_nuvio_compat')?.dataset.watchfusionCompatVersion === '2';
    })).toBe(true);

    const compatibility = await nuvioFrame.evaluate(() => {
      const style = document.getElementById('__watchfusion_nuvio_compat');
      return {
        version: style?.dataset.watchfusionCompatVersion || '',
        css: style?.textContent || ''
      };
    });

    expect(compatibility.version).toBe('2');
    expect(compatibility.css).toContain('--watchfusion-player-dialog-bottom');
    expect(compatibility.css).toContain('#playerSubtitleDialog');
    expect(compatibility.css).toContain('#playerAudioDialog');
    expect(compatibility.css).toContain('#playerSpeedDialog');
    expect(compatibility.css).toContain('#playerSourcesPanel');
    expect(compatibility.css).toContain('#playerModalBackdrop');
    expect(compatibility.css).toContain('#playerControlsOverlay.modal-blocked{pointer-events:auto!important}');
  });
});
