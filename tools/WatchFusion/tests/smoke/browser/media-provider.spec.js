import { test, expect } from '@playwright/test';

async function createRoom(page, code) {
  await page.goto('/');
  await page.click('#headerToggleBtn');
  await page.click('#startPartyBtn');
  await page.fill('#nameInput', 'MediaHost');
  await page.fill('#roomInput', code);
  await page.click('#createBtn');
  await expect(page).toHaveURL(/\/watch\//, { timeout: 5000 });
  await expect(page.locator('#app')).toBeVisible();
}

test.describe('External media provider layer', () => {
  test('external media controls and resolved source metadata are visible to the host', async ({ page }) => {
    await createRoom(page, '812');
    await page.click('#resolveTabBtn');
    await expect(page.locator('#findMediaPanel')).toBeVisible();
    await expect(page.locator('#sourceInput')).toBeVisible();

    await page.route('**/api/media/resolve', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          title: 'Example Episode',
          results: [
            { url: 'https://cdn.example.test/episode/master.m3u8', type: 'hls', server: 'kiwi', quality: '1080p', audio: 'sub', subtitles: [] },
            { url: 'https://cdn.example.test/episode/backup.m3u8', type: 'hls', server: 'arc', quality: '720p', audio: 'dub', subtitles: [] }
          ]
        })
      });
    });

    await page.fill('#sourceInput', 'https://example.test/watch/episode-1?ep=1');
    await page.click('#loadBtn');
    await expect(page.locator('#mediaSourceResults')).toBeVisible();
    await expect(page.locator('#mediaSourceSelect option')).toHaveCount(2);
    await expect(page.locator('#mediaMeta')).toContainText('Example Episode');
  });

  test('direct HLS source becomes authoritative room media state', async ({ page }) => {
    await createRoom(page, '813');
    await page.click('#resolveTabBtn');
    await expect(page.locator('#findMediaPanel')).toBeVisible();
    await page.fill('#sourceInput', 'https://example.com/episode/master.m3u8');
    await page.click('#loadBtn');
    await expect(page.locator('#sourceModeLabel')).toHaveText('External media');
    await expect(page.locator('#mediaMeta')).toContainText(/Direct media|example\.com/i);
  });
});
