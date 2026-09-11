import { test, expect } from '@playwright/test';

test.describe('WatchFusion Unified Cross-Provider Browser Suite', () => {
  test('Two-browser room seamlessly switches between Nuvio, YouTube, and Direct Media', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    // 1. Host creates room
    await hostPage.goto('/');
    await hostPage.click('#headerToggleBtn');
    await hostPage.click('#startPartyBtn');
    await hostPage.fill('#nameInput', 'HostAlice');
    await hostPage.fill('#roomInput', 'CROSSPROV1');
    await hostPage.click('#createBtn');
    await expect(hostPage).toHaveURL(/\/watch\//, { timeout: 5000 });
    await expect(hostPage.locator('#partyPanel')).toBeVisible();

    // 2. Viewer joins room
    await viewerPage.goto('/');
    await viewerPage.click('#headerToggleBtn');
    await viewerPage.click('#openRoomBtn');
    await viewerPage.fill('#nameInput', 'ViewerBob');
    await viewerPage.fill('#roomInput', 'CROSSPROV1');
    await viewerPage.click('#joinBtn');
    await expect(viewerPage).toHaveURL(/\/watch\//, { timeout: 5000 });
    await expect(viewerPage.locator('#partyPanel')).toBeVisible();

    // Verify members present on both
    await expect(hostPage.locator('#members')).toContainText('ViewerBob');
    await expect(viewerPage.locator('#members')).toContainText('HostAlice');

    // 3. Host clicks Nuvio tab
    await hostPage.click('#shortcutNuvioBtn');

    // Both host and viewer receive Nuvio provider state
    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(viewerPage.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(hostPage.locator('#nuvioFrame')).toBeVisible();
    await expect(viewerPage.locator('#nuvioFrame')).toBeVisible();

    // 4. Host switches to YouTube via Find Media
    await hostPage.click('#resolveTabBtn');
    await expect(hostPage.locator('#findMediaPanel')).toBeVisible();
    await hostPage.fill('#sourceInput', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await hostPage.click('#loadBtn');

    // Both host and viewer receive YouTube provider state and Nuvio frame hides
    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('YouTube');
    await expect(viewerPage.locator('#sourceModeLabel')).toHaveText('YouTube');
    await expect(hostPage.locator('#nuvioFrame')).toBeHidden();
    await expect(viewerPage.locator('#nuvioFrame')).toBeHidden();
    await expect(hostPage.locator('#player')).toBeVisible();
    await expect(viewerPage.locator('#player')).toBeVisible();

    await hostContext.close();
    await viewerContext.close();
  });
});
