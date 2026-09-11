import { test, expect } from '@playwright/test';

test.describe('WatchFusion Solo-First & Media Promotion Suite', () => {
  test('Solo YouTube -> Start Watch Party -> promote source -> viewer joins', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    // 1. Host enters in Solo mode (partyPanel and headerActions hidden by default)
    await hostPage.goto('/');
    await expect(hostPage.locator('#syncStatus')).toHaveText('Solo mode');
    await expect(hostPage.locator('#partyPanel')).toBeHidden();
    await expect(hostPage.locator('#headerActions')).toBeHidden();

    // 2. Open Find Media and load YouTube in solo mode
    await hostPage.click('#resolveTabBtn');
    await expect(hostPage.locator('#findMediaPanel')).toBeVisible();
    await hostPage.fill('#sourceInput', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await hostPage.click('#loadBtn');
    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('YouTube');
    await expect(hostPage.locator('#player')).toBeVisible();

    // 3. Expand header and click Start Watch Party to promote current source
    await hostPage.click('#headerToggleBtn');
    await expect(hostPage.locator('#headerActions')).toBeVisible();
    await hostPage.click('#startPartyBtn');
    await expect(hostPage.locator('#lobby')).toBeVisible();
    await hostPage.fill('#nameInput', 'HostSolo');
    await hostPage.fill('#roomInput', 'PROMOTEROOM1');
    await hostPage.click('#createBtn');
    await expect(hostPage).toHaveURL(/\/watch\//, { timeout: 5000 });

    // 4. Verify host is in room, partyPanel is visible, and YouTube video is retained
    await expect(hostPage.locator('#lobby')).toBeHidden();
    await expect(hostPage.locator('#partyPanel')).toBeVisible();
    await expect(hostPage.locator('#syncStatus')).not.toHaveText('Solo mode');
    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('YouTube');

    // 5. Viewer joins the room
    await viewerPage.goto('/');
    await viewerPage.click('#headerToggleBtn');
    await viewerPage.click('#openRoomBtn');
    await viewerPage.fill('#nameInput', 'ViewerSolo');
    await viewerPage.fill('#roomInput', 'PROMOTEROOM1');
    await viewerPage.click('#joinBtn');
    await expect(viewerPage).toHaveURL(/\/watch\//, { timeout: 5000 });

    // 6. Viewer receives the promoted YouTube state and party panel is visible
    await expect(viewerPage.locator('#partyPanel')).toBeVisible();
    await expect(viewerPage.locator('#sourceModeLabel')).toHaveText('YouTube');
    await expect(viewerPage.locator('#members')).toContainText('HostSolo');
    await expect(hostPage.locator('#members')).toContainText('ViewerSolo');

    await hostContext.close();
    await viewerContext.close();
  });

  test('Solo Nuvio -> Start Watch Party -> promote source -> viewer joins', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    // 1. Host enters in Solo mode
    await hostPage.goto('/');
    await expect(hostPage.locator('#syncStatus')).toHaveText('Solo mode');
    await expect(hostPage.locator('#partyPanel')).toBeHidden();

    // 2. Click Nuvio tab in solo mode
    await hostPage.click('#shortcutNuvioBtn');
    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(hostPage.locator('#nuvioFrame')).toBeVisible();

    // 3. Promote Nuvio into a Watch Party
    await hostPage.click('#headerToggleBtn');
    await hostPage.click('#startPartyBtn');
    await expect(hostPage.locator('#lobby')).toBeVisible();
    await hostPage.fill('#nameInput', 'NuvioHost');
    await hostPage.fill('#roomInput', 'NUVIOROOM1');
    await hostPage.click('#createBtn');
    await expect(hostPage).toHaveURL(/\/watch\//, { timeout: 5000 });

    // 4. Host room is active with Nuvio and partyPanel is visible
    await expect(hostPage.locator('#partyPanel')).toBeVisible();
    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(hostPage.locator('#nuvioFrame')).toBeVisible();

    // 5. Viewer joins
    await viewerPage.goto('/');
    await viewerPage.click('#headerToggleBtn');
    await viewerPage.click('#openRoomBtn');
    await viewerPage.fill('#nameInput', 'NuvioViewer');
    await viewerPage.fill('#roomInput', 'NUVIOROOM1');
    await viewerPage.click('#joinBtn');
    await expect(viewerPage).toHaveURL(/\/watch\//, { timeout: 5000 });

    // 6. Viewer receives the promoted Nuvio source
    await expect(viewerPage.locator('#partyPanel')).toBeVisible();
    await expect(viewerPage.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(viewerPage.locator('#nuvioFrame')).toBeVisible();
    await expect(viewerPage.locator('#members')).toContainText('NuvioHost');

    await hostContext.close();
    await viewerContext.close();
  });
});
