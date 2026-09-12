import { test, expect } from '@playwright/test';

test.describe('WatchFusion EveOS Detach & Reattach Continuity', () => {
  test('watchFusionContinuityState captures and restores state snapshots', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      const stateApi = window.watchFusionContinuityState;
      if (!stateApi) throw new Error('watchFusionContinuityState not found');

      // Capture initial snapshot
      const snapshot = await stateApi.captureSnapshot({ role: 'embedded' });

      // Modify storage
      localStorage.setItem('continuity-test-key', 'continuity-val-999');

      // Re-capture
      const snapshotWithStorage = await stateApi.captureSnapshot({ role: 'embedded' });

      // Clear storage
      localStorage.removeItem('continuity-test-key');

      // Apply snapshot
      await stateApi.applySnapshot(snapshotWithStorage, 'detached');

      return {
        hasSnapshot: !!snapshot,
        protocol: snapshot.protocol,
        restoredStorageValue: localStorage.getItem('continuity-test-key')
      };
    });

    expect(result.hasSnapshot).toBe(true);
    expect(result.protocol).toBe(1);
    expect(result.restoredStorageValue).toBe('continuity-val-999');
  });

  test('Nuvio auth is seeded before an already-loaded detached frame reboots', async ({ page }) => {
    await page.route('**/nuvio/dist/index.html**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><body data-access=""><script>
          document.body.dataset.access = localStorage.getItem('access_token') || '';
        <\/script></body></html>`
      });
    });

    await page.goto('/');
    await page.evaluate(() => {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('is_anonymous_session');
      const frame = document.getElementById('nuvioFrame');
      frame.src = '/nuvio/dist/index.html';
    });

    const nuvioFrame = page.frameLocator('#nuvioFrame');
    await expect(nuvioFrame.locator('body')).toHaveAttribute('data-access', '');

    await page.evaluate(async () => {
      const stateApi = window.watchFusionContinuityState;
      await stateApi.applySnapshot({
        protocol: 1,
        capturedAt: Date.now(),
        source: { kind: 'ready', type: 'ready', title: 'Ready' },
        storage: { local: [], session: [] },
        nuvioSession: {
          access_token: 'partition-access-token',
          refresh_token: 'partition-refresh-token',
          is_anonymous_session: null
        }
      }, 'detached');
    });

    await expect(nuvioFrame.locator('body')).toHaveAttribute('data-access', 'partition-access-token');
    const restored = await page.evaluate(() => ({
      access: localStorage.getItem('access_token'),
      refresh: localStorage.getItem('refresh_token'),
      anonymous: localStorage.getItem('is_anonymous_session')
    }));
    expect(restored).toEqual({
      access: 'partition-access-token',
      refresh: 'partition-refresh-token',
      anonymous: null
    });
  });

  test('watchFusionContinuityState applies VoxelVision snapshot settings', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      const stateApi = window.watchFusionContinuityState;

      // Switch to VoxelVision
      document.getElementById('shortcutVoxelVisionBtn')?.click();

      const snapshot = {
        protocol: 1,
        capturedAt: Date.now(),
        source: { kind: 'voxelvision', type: 'voxelvision', title: 'VoxelVision' },
        voxel: {
          src: '/voxelvision/media/voxelvision-demo.mp4',
          title: 'Spec Continuity Voxel',
          depthMode: 'fast',
          settings: {
            brightness: 1.5,
            contrast: 1.2,
            height: 10,
            gap: 2
          },
          playback: {
            currentTime: 2.0,
            paused: true,
            playbackRate: 1.0,
            volume: 1.0,
            muted: false
          }
        }
      };

      await stateApi.applySnapshot(snapshot, 'detached');

      return {
        sourceMode: document.getElementById('sourceModeLabel')?.textContent,
        frameVisible: !document.getElementById('voxelVisionFrame')?.hidden
      };
    });

    expect(result.sourceMode).toBe('VoxelVision');
    expect(result.frameVisible).toBe(true);
  });

  test('Full continuity relay between embedded iframe and detached popup', async ({ page }) => {
    await page.goto('/');

    // Set up host page simulating EveOS continuity relay on loopback origin
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head><title>EveOS Continuity Test Host</title></head>
      <body>
        <button id="openPopupBtn" onclick="openPopup()">Detach</button>
        <iframe id="wfFrame" src="/?eveos=1" style="width:800px;height:600px;"></iframe>
        <script>
          let embeddedWin = null;
          let detachedWin = null;
          const sessionId = 'continuity-test-session';

          function postTo(target, payload) {
            target?.postMessage({
              ...payload,
              source: 'EveOS',
              version: 1,
              sessionId
            }, '*');
          }

          function openPopup() {
            detachedWin = window.open('/?eveosDetached=1', 'eveWatchFusionWindow');
          }

          window.addEventListener('message', (e) => {
            const data = e.data;
            if (!data || data.source !== 'WatchFusion') return;

            if (data.type === 'watchfusion:embedded-presence') {
              embeddedWin = e.source;
              postTo(embeddedWin, { type: 'watchfusion:continuity-config', role: 'embedded' });
            } else if (data.type === 'watchfusion:detached-presence') {
              detachedWin = e.source;
              postTo(detachedWin, { type: 'watchfusion:continuity-config', role: 'detached' });
            } else if (data.type === 'watchfusion:continuity-request') {
              postTo(embeddedWin, data);
            } else if (data.type === 'watchfusion:continuity-handoff') {
              const target = data.targetRole === 'detached' ? detachedWin : embeddedWin;
              postTo(target, data);
            } else if (data.type === 'watchfusion:continuity-applied') {
              const target = data.sourceRole === 'detached' ? detachedWin : embeddedWin;
              postTo(target, data);
            }
          });
        </script>
      </body>
      </html>
    `);

    const frameLoc = page.frameLocator('#wfFrame');
    await expect(frameLoc.locator('#mediaStage')).toBeVisible({ timeout: 15000 });

    // Verify embedded bridge is active
    const frame = page.frame({ url: /\/\?eveos=1/ });
    await expect.poll(async () => {
      return await frame?.evaluate(() => window.watchFusionEveContinuity?.isActive?.());
    }, { timeout: 10000 }).toBe(true);

    // 1. Open detached popup
    const [detachedPage] = await Promise.all([
      page.context().waitForEvent('page'),
      page.click('#openPopupBtn')
    ]);

    await detachedPage.waitForLoadState('domcontentloaded');

    // Detached popup should display the Reattach button
    await expect(detachedPage.locator('#reattachEveOSBtn')).toBeVisible({ timeout: 10000 });

    // Detached bridge should receive handoff and become active
    await expect.poll(async () => {
      return await detachedPage.evaluate(() => window.watchFusionEveContinuity?.isActive?.());
    }, { timeout: 10000 }).toBe(true);

    // Embedded frame should have parked itself
    await expect.poll(async () => {
      return await frame?.evaluate(() => window.watchFusionEveContinuity?.isActive?.());
    }, { timeout: 10000 }).toBe(false);

    // 2. Reattach to embedded: click Reattach button in detached
    await detachedPage.click('#reattachEveOSBtn');

    // Embedded should reclaim active ownership
    await expect.poll(async () => {
      return await frame?.evaluate(() => window.watchFusionEveContinuity?.isActive?.());
    }, { timeout: 10000 }).toBe(true);

    // Detached should close itself after transfer ACK
    await expect.poll(async () => detachedPage.isClosed(), { timeout: 10000 }).toBe(true);
  });
});
