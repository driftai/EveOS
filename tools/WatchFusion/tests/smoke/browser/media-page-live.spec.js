import { test, expect } from '@playwright/test';

const pageUrl = process.env.LIVE_MEDIA_PAGE_URL;

test('Live watch-page resolver discovers a playable external media source', async ({ page }) => {
  test.skip(!pageUrl, 'Set LIVE_MEDIA_PAGE_URL to run the live watch-page resolver smoke.');
  test.setTimeout(60000);
  await page.goto('/');
  await page.fill('#nameInput', 'ResolverSmokeHost');
  await page.fill('#roomInput', '824');
  await page.click('#createBtn');
  await expect(page.locator('#app')).toBeVisible({ timeout: 5000 });
  await page.fill('#mediaSourceInput', pageUrl);
  await page.click('#resolveMediaBtn');
  await expect(page.locator('#mediaSourceResults')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#mediaSourceSelect option')).not.toHaveCount(0);
  await expect(page.locator('#mediaMeta')).not.toHaveText('');
});
