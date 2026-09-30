import { test, expect } from '@playwright/test';

test.describe('WatchFusion room media unload', () => {

  test('Host unloads media for every room tab without deleting the room', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    await viewerContext.addInitScript(() => localStorage.setItem('wp-name', 'UnloadViewer'));
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();

    await hostPage.goto('/');
    await hostPage.click('#headerToggleBtn');
    await hostPage.click('#startPartyBtn');
    await hostPage.fill('#nameInput', 'UnloadHost');
    await hostPage.fill('#roomInput', '909');
    await hostPage.click('#createBtn');
    await expect(hostPage).toHaveURL(/\/watch\//, { timeout: 5000 });
    await viewerPage.goto(hostPage.url());
    await expect(viewerPage.locator('#members')).toContainText('UnloadHost');

    await hostPage.evaluate(async () => {
      await command('source', {
        source: {
          kind: 'live',
          type: 'live',
          streamId: '00000000-0000-4000-8000-000000000909',
          viewerToken: 'synthetic-test-token',
          title: 'Synthetic live source',
          mode: 'tab'
        }
      });
    });
    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('Live media');
    await expect(viewerPage.locator('#sourceModeLabel')).toHaveText('Live media');
    await expect(hostPage.locator('#unloadMediaBtn')).toBeVisible();
    await expect(viewerPage.locator('#unloadMediaBtn')).toBeHidden();

    await hostPage.click('#unloadMediaBtn');

    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('Ready');
    await expect(viewerPage.locator('#sourceModeLabel')).toHaveText('Ready');
    await expect(hostPage.locator('#mediaStage')).toHaveClass(/media-stage-empty/);
    await expect(viewerPage.locator('#mediaStage')).toHaveClass(/media-stage-empty/);
    await expect(hostPage.locator('#partyPanel')).toBeVisible();
    await expect(viewerPage.locator('#partyPanel')).toBeVisible();
    await expect(hostPage.locator('#members')).toContainText('UnloadViewer');

    await hostContext.close();
    await viewerContext.close();
  });

});
