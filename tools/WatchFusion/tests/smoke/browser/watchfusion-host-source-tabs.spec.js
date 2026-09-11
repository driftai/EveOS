import { test, expect } from '@playwright/test';

test.describe('WatchFusion host source controls', () => {
  test('Nuvio tab is a real host control and opens the Nuvio stage in solo mode', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error?.message || error)));

    await page.goto('/');

    await expect(page.locator('#shortcutNuvioBtn')).toBeVisible();
    await expect(page.locator('#resolveTabBtn')).toBeVisible();
    await expect(page.locator('#mediaStage')).toHaveClass(/media-stage-empty/);
    await expect(page.locator('#nuvioFrame')).toBeHidden();

    await page.locator('#shortcutNuvioBtn').click();

    await expect(page.locator('#mediaStage')).not.toHaveClass(/media-stage-empty/);
    await expect(page.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(page.locator('#shortcutNuvioBtn')).toHaveClass(/active/);
    await expect(page.locator('#nuvioFrame')).toBeVisible();
    await expect(page.locator('#nuvioFrame')).toHaveAttribute('src', /\/nuvio\/dist\/index\.html$/);
    expect(pageErrors).toEqual([]);
  });

  test('Find Media remains independently clickable after Nuvio is selected', async ({ page }) => {
    await page.goto('/');

    await page.locator('#shortcutNuvioBtn').click();
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    await page.locator('#resolveTabBtn').click();
    await expect(page.locator('#findMediaPanel')).toBeVisible();
    await expect(page.locator('#sourceModeLabel')).toHaveText('Ready');
    await expect(page.locator('#resolveTabBtn')).toHaveClass(/active/);
  });

  test('VoxelVision opens as a mounted source and can switch back to Nuvio', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error?.message || error)));
    await page.goto('/');

    await page.locator('#shortcutVoxelVisionBtn').click();
    await expect(page.locator('#mediaStage')).not.toHaveClass(/media-stage-empty/);
    await expect(page.locator('#sourceModeLabel')).toHaveText('VoxelVision');
    await expect(page.locator('#shortcutVoxelVisionBtn')).toHaveClass(/active/);
    await expect(page.locator('#voxelVisionFrame')).toBeVisible();
    await expect(page.locator('#voxelVisionFrame')).toHaveAttribute('src', /\/voxelvision\/$/);
    await expect(page.frameLocator('#voxelVisionFrame').locator('#renderCanvas')).toBeVisible();

    await page.locator('#shortcutNuvioBtn').click();
    await expect(page.locator('#voxelVisionFrame')).toBeHidden();
    await expect(page.locator('#nuvioFrame')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
