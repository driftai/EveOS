import { test, expect } from '@playwright/test';

test.describe('Nuvio native player pointer gateway', () => {
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
