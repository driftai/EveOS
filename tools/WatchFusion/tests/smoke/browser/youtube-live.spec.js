import { test, expect } from '@playwright/test';

const DEFAULT_VIDEO_ID = 'M7lc1UVf-VE';
const TEST_VIDEO_INPUT = process.env.LIVE_YOUTUBE_URL || `https://www.youtube.com/watch?v=${DEFAULT_VIDEO_ID}`;
// Extract video ID (support youtu.be, watch?v=, or raw ID)
const idMatch = TEST_VIDEO_INPUT.match(/(?:v=|\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
const TEST_VIDEO_ID = idMatch ? idMatch[1] : DEFAULT_VIDEO_ID;

test.describe('Live YouTube IFrame integration', () => {
  test('loads the real YouTube IFrame API and attaches the requested video', async ({ page }) => {
    test.skip(process.env.RUN_LIVE_YOUTUBE !== '1', 'Opt-in live YouTube integration: set RUN_LIVE_YOUTUBE=1');

    await page.goto('/');
    await page.fill('#nameInput', 'YouTubeLiveSmoke');
    await page.fill('#roomInput', 'YT-LIVE-1');
    await page.click('#createBtn');

    await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });

    // Exercise the actual WatchParty source-loading path with the requested URL
    await page.fill('#sourceInput', TEST_VIDEO_INPUT);
    await page.click('#loadBtn');

    // WatchParty must acknowledge the successful source command.
    await expect(page.locator('#syncStatus')).toHaveText('Video ready', { timeout: 10000 });

    // The real YouTube IFrame API should be present in the page.
    await expect.poll(
      () => page.evaluate(() => !!window.YT?.Player),
      { timeout: 15000, message: 'YouTube IFrame API did not initialize in the browser.' }
    ).toBe(true);

    // The API replaces the original #player container with a real YouTube iframe.
    const iframe = page.locator('.player iframe, iframe#player');
    await expect(iframe).toBeAttached({ timeout: 15000 });

    // Confirm the iframe actually targets the requested live YouTube video.
    await expect.poll(
      () => page.frames().some(frame => frame.url().includes(`/embed/${TEST_VIDEO_ID}`)),
      { timeout: 15000, message: 'YouTube iframe for the requested video was not attached.' }
    ).toBe(true);
  });
});
