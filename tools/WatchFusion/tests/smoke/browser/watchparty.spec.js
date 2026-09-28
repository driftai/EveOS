import { test, expect } from '@playwright/test';
import { YOUTUBE_FIXTURES } from '../fixtures/youtube.js';

test.describe('WatchFusion Multi-Client Suite', () => {

  test('Lobby renders with expected initial controls', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#partyPanel')).toBeHidden();
    await expect(page.locator('#headerActions')).toBeHidden();
    await page.click('#headerToggleBtn');
    await expect(page.locator('#startPartyBtn')).toBeVisible();
    await page.click('#startPartyBtn');

    await expect(page.locator('#lobby')).toBeVisible();
    await expect(page.locator('#nameInput')).toBeVisible();
    await expect(page.locator('#createBtn')).toBeVisible();
    await expect(page.locator('#roomInput')).toBeVisible();
    await expect(page.locator('#joinBtn')).toBeVisible();
    await page.click('#closeLobbyBtn');
    await expect(page.locator('#lobby')).toBeHidden();
  });

  test('Create room establishes host room session', async ({ page }) => {
    await page.goto('/');

    await page.click('#headerToggleBtn');
    await page.click('#startPartyBtn');
    await page.fill('#nameInput', 'HostSmoke');
    await page.fill('#roomInput', '901');
    await page.click('#createBtn');

    // App should become visible and URL updated to /watch/...
    await expect(page.locator('#app')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#lobby')).toBeHidden();
    await expect(page.locator('#partyPanel')).toBeVisible();
    await expect(page).toHaveURL(/\/watch\//);

    // Host badge and room pill
    await expect(page.locator('#hostBadge')).toHaveText('YOU ARE HOST');
    await expect(page.locator('#roomPill')).toContainText('901');
    await expect(page.locator('#members')).toContainText('HostSmoke');
    await expect(page.locator('#members')).toContainText('★');
  });

  test('Embedded room creation preserves EveOS mode and reveals the party UI', async ({ page }) => {
    await page.goto('/?eveos=1');
    await page.click('#headerToggleBtn');
    await page.click('#startPartyBtn');
    await page.fill('#nameInput', 'EmbeddedHost');
    await page.fill('#roomInput', '905');
    await page.click('#createBtn');

    await expect(page).toHaveURL(/\/watch\/905\?eveos=1$/);
    await expect(page.locator('html')).toHaveClass(/watchfusion-room-active/);
    await expect(page.locator('#partyPanel')).toBeVisible();
    const columns = await page.locator('.grid').evaluate(element => getComputedStyle(element).gridTemplateColumns);
    expect(columns.trim().split(/\s+/)).toHaveLength(2);

    await page.fill('#chatInput', Array.from({ length: 400 }, (_, index) => `scroll-line-${index}`).join('\n'));
    await page.press('#chatInput', 'Enter');
    await expect(page.locator('.msg')).toHaveCount(1);
    const scrollState = await page.locator('#chat').evaluate(chat => {
      const scrollable = chat.scrollHeight > chat.clientHeight;
      chat.scrollTop = 0;
      window.render();
      return { scrollable, scrollTop: chat.scrollTop };
    });
    expect(scrollState.scrollable).toBe(true);
    expect(scrollState.scrollTop).toBe(0);
  });

  test('LAN share link uses the physical address and visible join code', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    await hostPage.route('**/api/network-info', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        localMode: false,
        localOnly: false,
        requestIsVirtual: false,
        preferredLanAddress: 'http://192.168.50.7:9087',
        lanAddresses: ['http://192.168.50.7:9087'],
        preferredLanHost: 'http://192-168-50-7.sslip.io:9087'
      })
    }));
    await hostPage.goto('/?eveos=1');
    await hostPage.click('#headerToggleBtn');
    await hostPage.click('#startPartyBtn');
    await hostPage.fill('#nameInput', 'LanHost');
    await hostPage.fill('#roomInput', '906');
    await hostPage.click('#createBtn');

    const shareLink = await hostPage.evaluate(() => shareRoomLink());
    expect(shareLink).toBe('http://192.168.50.7:9087/watch/906');

    const viewerContext = await browser.newContext();
    await viewerContext.addInitScript(() => localStorage.setItem('wp-name', 'LanViewer'));
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto('/watch/906');
    await expect(viewerPage.locator('#partyPanel')).toBeVisible();
    await expect(viewerPage.locator('#members')).toContainText('LanHost');
    await expect(viewerPage.locator('#members')).toContainText('LanViewer');
    await hostContext.close();
    await viewerContext.close();
  });

  test('Two-browser host and viewer synchronization, chat, and source load', async ({ browser }) => {
    // 1. Host creates room
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    await hostPage.goto('/');
    await hostPage.click('#headerToggleBtn');
    await hostPage.click('#startPartyBtn');
    await hostPage.fill('#nameInput', 'HostAlice');
    await hostPage.fill('#roomInput', '902');
    await hostPage.click('#createBtn');
    await expect(hostPage).toHaveURL(/\/watch\//, { timeout: 5000 });
    await expect(hostPage.locator('#roomPill')).not.toHaveText('Solo');

    const hostUrl = hostPage.url();

    // 2. Viewer joins via direct room link with custom name
    const viewerContext = await browser.newContext();
    await viewerContext.addInitScript(() => {
      localStorage.setItem('wp-name', 'ViewerBob');
    });
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(hostUrl);

    await expect(viewerPage.locator('#app')).toBeVisible();
    await expect(viewerPage.locator('#partyPanel')).toBeVisible();
    await expect(viewerPage.locator('#hostBadge')).toHaveText('');

    // Verify both members show in both browsers
    await expect(hostPage.locator('#members')).toContainText('ViewerBob');
    await expect(viewerPage.locator('#members')).toContainText('HostAlice');

    // 3. Chat: Host sends message, viewer receives in real time
    await hostPage.fill('#chatInput', 'Welcome to the party!');
    await hostPage.press('#chatInput', 'Enter');

    await expect(viewerPage.locator('#chat')).toContainText('Welcome to the party!');
    await expect(viewerPage.locator('#chat')).toContainText('HostAlice');
    await expect(viewerPage.locator('[data-copy-message]')).toHaveCount(1);

    // Viewer replies
    await viewerPage.fill('#chatInput', 'Thanks Alice!');
    await viewerPage.press('#chatInput', 'Enter');

    await expect(hostPage.locator('#chat')).toContainText('Thanks Alice!');
    await expect(hostPage.locator('#chat')).toContainText('ViewerBob');

    const pixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await viewerPage.locator('#chatImageInput').setInputFiles({ name: 'relay.png', mimeType: 'image/png', buffer: pixelPng });
    await expect(hostPage.locator('.message-image')).toHaveCount(1);
    await expect(hostPage.locator('.message-file-name')).toHaveText('relay.png');
    await expect(hostPage.locator('.message-download')).toHaveCount(1);

    // 4. Source loading & ready state transition via Find Media
    const sampleVideoUrl = YOUTUBE_FIXTURES.valid[0].input;
    await hostPage.click('#resolveTabBtn');
    await hostPage.fill('#sourceInput', sampleVideoUrl);
    await hostPage.click('#loadBtn');

    // Verify UI transitions to "Video ready" (not the stale "Loading new video…")
    await expect(hostPage.locator('#syncStatus')).toHaveText('Video ready', { timeout: 5000 });

    await hostContext.close();
    await viewerContext.close();
  });

  test('Regression: Client does not issue periodic 5-second forced seeks', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    let seekCommandCount = 0;

    // Monitor API commands
    await page.route('**/api/rooms/*/command', async (route) => {
      const postData = route.request().postDataJSON();
      if (postData?.type === 'seek') {
        seekCommandCount++;
      }
      await route.continue();
    });

    await page.goto('/');
    await page.click('#headerToggleBtn');
    await page.click('#startPartyBtn');
    await page.fill('#nameInput', 'SeekTester');
    await page.fill('#roomInput', '903');
    await page.click('#createBtn');
    await expect(page).toHaveURL(/\/watch\//, { timeout: 5000 });

    // Load video via Find Media
    await page.click('#resolveTabBtn');
    await page.fill('#sourceInput', YOUTUBE_FIXTURES.valid[0].input);
    await page.click('#loadBtn');
    await expect(page.locator('#syncStatus')).toHaveText('Video ready');

    // Wait 11 seconds (which previously fired at least 2 forced seek commands)
    await page.waitForTimeout(11000);

    // Verify no automatic continuous seek commands were fired
    expect(seekCommandCount).toBe(0);

    await context.close();
  });

  test('Late joiner receives active room and video state', async ({ browser }) => {
    // 1. Host creates room and sets video
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    await hostPage.goto('/');
    await hostPage.click('#headerToggleBtn');
    await hostPage.click('#startPartyBtn');
    await hostPage.fill('#nameInput', 'LateHost');
    await hostPage.fill('#roomInput', '904');
    await hostPage.click('#createBtn');
    await expect(hostPage).toHaveURL(/\/watch\//, { timeout: 5000 });

    await hostPage.click('#resolveTabBtn');
    await hostPage.fill('#sourceInput', YOUTUBE_FIXTURES.valid[0].input);
    await hostPage.click('#loadBtn');
    await expect(hostPage.locator('#syncStatus')).toHaveText('Video ready');

    const roomUrl = hostPage.url();

    // 2. Late joiner connects after video was already loaded
    const lateContext = await browser.newContext();
    await lateContext.addInitScript(() => {
      localStorage.setItem('wp-name', 'LateJoiner');
    });
    const latePage = await lateContext.newPage();
    await latePage.goto(roomUrl);

    await expect(latePage.locator('#app')).toBeVisible();
    await expect(latePage.locator('#partyPanel')).toBeVisible();
    await expect(latePage.locator('#members')).toContainText('LateJoiner');
    await expect(latePage.locator('#members')).toContainText('LateHost');

    // Late joiner should see the room is connected
    await expect(latePage.locator('#syncStatus')).toContainText(/Connected|Joining/);

    await hostContext.close();
    await lateContext.close();
  });

  test('Page reload recovers active room session without destroying room', async ({ page }) => {
    await page.goto('/');
    await page.click('#headerToggleBtn');
    await page.click('#startPartyBtn');
    await page.fill('#nameInput', 'ReloadHost');
    await page.fill('#roomInput', 'RELOAD1');
    await page.click('#createBtn');
    await expect(page).toHaveURL(/\/watch\//, { timeout: 5000 });

    const initialPillText = await page.locator('#roomPill').textContent();

    await page.reload();

    // After reload, app should resume connected state with the same room
    await expect(page.locator('#app')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#partyPanel')).toBeVisible();
    await expect(page.locator('#roomPill')).toHaveText(initialPillText);
    await expect(page.locator('#hostBadge')).toHaveText('YOU ARE HOST');
  });

});
