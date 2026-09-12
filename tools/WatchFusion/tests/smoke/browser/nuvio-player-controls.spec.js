import { test, expect } from '@playwright/test';

test.describe('Nuvio native player pointer gateway', () => {
  test('toolbar releases Back between presses and Home, Reload, Close remain usable', async ({ page }) => {
    // Isolated navigation contract, not real stream-discovery qualification.
    let boots = 0;
    await page.route('**/nuvio/dist/index.html', route => {
      boots += 1;
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <body><output id="screen">player-controls</output><script>
        let held = false;
        const routes = ['player-controls', 'player', 'stream', 'detail'];
        let index = 0;
        document.addEventListener('keydown', event => {
          if (!document.contains(event.target) || event.key !== 'Escape' || held) return;
          held = true;
          document.getElementById('screen').textContent = routes[++index];
        }, true);
        document.addEventListener('keyup', event => { if (event.key === 'Escape') held = false; }, true);
        </script></body>` });
    });
    await page.goto('/');
    await page.locator('#shortcutNuvioBtn').click();
    const screen = page.frameLocator('#nuvioFrame').locator('#screen');
    await expect(screen).toHaveText('player-controls');
    for (const expected of ['player', 'stream', 'detail']) {
      await page.locator('#nuvioBackBtn').click();
      await expect(screen).toHaveText(expected);
    }
    const firstBoot = boots;
    await page.locator('#nuvioHomeBtn').click();
    await expect.poll(() => boots).toBe(firstBoot + 1);
    await expect(screen).toHaveText('player-controls');
    await page.locator('#nuvioReloadBtn').click();
    await expect.poll(() => boots).toBe(firstBoot + 2);
    await expect(screen).toHaveText('player-controls');
    await page.locator('#nuvioCloseBtn').click();
    await expect(page.locator('#nuvioFrame')).toBeHidden();
    await expect(page.locator('#nuvioToolbar')).toBeHidden();
    await page.locator('#shortcutNuvioBtn').click();
    await expect(screen).toHaveText('player-controls');
  });

  test('v6 gateway is ready and rejects synthetic control activation', async ({ page }) => {
    await page.goto('/');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const nuvioFrameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await nuvioFrameElement.contentFrame();
    expect(nuvioFrame).not.toBeNull();

    await nuvioFrame.waitForFunction(() => (
      window.watchFusionExternalNuvioMouse?.version === 6 &&
      window.__WATCHFUSION_NUVIO_POINTER_API__?.version === 6
    ), null, { timeout: 10000 });

    const result = await nuvioFrame.evaluate(() => {
      const bridge = window.watchFusionExternalNuvioMouse;
      const gateway = window.__WATCHFUSION_NUVIO_POINTER_API__;
      const before = bridge.status();
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const after = bridge.status();
      const nativeStatus = gateway.status();
      return {
        bridgeVersion: bridge.version,
        gatewayVersion: gateway.version,
        gatewayReady: after.gatewayReady,
        pointerEnabled: after.pointerEnabled,
        nativeEnabled: nativeStatus.enabled,
        observedSyntheticClick: after.clicks === before.clicks + 1,
        forwardedSyntheticClick: after.forwardedClicks !== before.forwardedClicks
      };
    });

    expect(result).toEqual({
      bridgeVersion: 6,
      gatewayVersion: 6,
      gatewayReady: true,
      pointerEnabled: true,
      nativeEnabled: true,
      observedSyntheticClick: true,
      forwardedSyntheticClick: false
    });
  });
});
