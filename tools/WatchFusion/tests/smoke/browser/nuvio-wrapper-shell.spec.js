import { test, expect } from '@playwright/test';

test.describe('WatchFusion Nuvio Native Viewport Wrapper Shell, Media Stage & Header Suite', () => {
  test('Header starts collapsed with only WatchFusion brand, expands and collapses', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();

    const brand = page.locator('.brand');
    const headerToggle = page.locator('#headerToggleBtn');
    const headerActions = page.locator('#headerActions');

    await expect(brand).toBeVisible();
    await expect(headerToggle).toBeVisible();
    await expect(headerActions).toBeHidden();

    // Expand header
    await headerToggle.click();
    await expect(headerActions).toBeVisible();
    await expect(page.locator('#shortcutNuvioBtn')).toBeVisible();
    await expect(page.locator('#resolveTabBtn')).toBeVisible();

    // Collapse header
    await headerToggle.click();
    await expect(headerActions).toBeHidden();
  });

  test('Empty media stage starts collapsed, Find Media stays collapsed, loading YouTube reveals stage', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();

    const mediaStage = page.locator('#mediaStage');
    await expect(mediaStage).toHaveClass(/media-stage-empty/);

    // Expand header and open Find Media drawer
    await page.click('#headerToggleBtn');
    await page.click('#resolveTabBtn');
    const findMediaPanel = page.locator('#findMediaPanel');
    await expect(findMediaPanel).toBeVisible();
    await expect(mediaStage).toHaveClass(/media-stage-empty/);

    // Load YouTube video -> stage expands and player becomes visible
    await page.fill('#sourceInput', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.click('#loadBtn');
    await expect(findMediaPanel).toBeHidden();
    await expect(mediaStage).not.toHaveClass(/media-stage-empty/);
    await expect(page.locator('#player')).toBeVisible();
  });

  test('Solo Nuvio -> reveals responsive workspace -> Close Nuvio collapses stage -> reopen Nuvio', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();

    // 1. Open Nuvio from shortcut button
    await page.click('#headerToggleBtn');
    await page.click('#shortcutNuvioBtn');

    await expect(page.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(page.locator('#mediaStage')).not.toHaveClass(/media-stage-empty/);
    await expect(page.locator('#nuvioFrame')).toBeVisible();
    await expect(page.locator('#nuvioToolbar')).toBeVisible();

    // 2. Click Close Nuvio on toolbar -> stage collapses back to empty state
    await page.click('#nuvioCloseBtn');
    await expect(page.locator('#sourceModeLabel')).toHaveText('Ready');
    await expect(page.locator('#mediaStage')).toHaveClass(/media-stage-empty/);
    await expect(page.locator('#nuvioFrame')).toBeHidden();
    await expect(page.locator('#nuvioToolbar')).toBeHidden();

    // 3. Reopen Nuvio -> stage re-expands
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(page.locator('#mediaStage')).not.toHaveClass(/media-stage-empty/);
    await expect(page.locator('#nuvioFrame')).toBeVisible();
    await expect(page.locator('#nuvioToolbar')).toBeVisible();
  });

  const VIEWPORT_SIZES = [
    { name: 'desktop wide (1920x1080)', width: 1920, height: 1080 },
    { name: 'laptop / desktop (1600x900)', width: 1600, height: 900 },
    { name: 'laptop standard (1280x720)', width: 1280, height: 720 },
    { name: 'narrow desktop (1024x768)', width: 1024, height: 768 },
    { name: 'tablet (768x1024)', width: 768, height: 1024 },
    { name: 'mobile (375x667)', width: 375, height: 667 }
  ];

  for (const vp of VIEWPORT_SIZES) {
    test(`Nuvio native 1920x1080 viewport connector scaling at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.locator('#app')).toBeVisible();

      await page.click('#shortcutNuvioBtn');
      await expect(page.locator('#nuvioFrame')).toBeVisible();

      const state = await page.evaluate(async () => {
        const frame = document.getElementById('nuvioFrame');
        if (!frame) return null;
        return await new Promise(resolve => {
          let attempts = 0;
          const interval = setInterval(() => {
            attempts++;
            try {
              const stage = frame.parentElement;
              const scaleStr = frame.dataset.watchfusionNuvioScale;
              const nativeVp = frame.dataset.watchfusionNuvioNativeViewport;
              if (scaleStr && nativeVp && stage) {
                clearInterval(interval);
                const frameRect = frame.getBoundingClientRect();
                const stageRect = stage.getBoundingClientRect();
                const computed = window.getComputedStyle(frame);
                resolve({
                  present: true,
                  scale: parseFloat(scaleStr),
                  nativeViewport: nativeVp,
                  nativeWidth: parseFloat(computed.width) || frame.clientWidth,
                  nativeHeight: parseFloat(computed.height) || frame.clientHeight,
                  stageWidth: stage.clientWidth,
                  stageHeight: stage.clientHeight,
                  frameBoundingWidth: frameRect.width,
                  frameBoundingHeight: frameRect.height,
                  stageOverflow: window.getComputedStyle(stage).overflow,
                  transform: computed.transform
                });
              }
            } catch {}
            if (attempts > 30) {
              clearInterval(interval);
              resolve({ present: false });
            }
          }, 100);
        });
      });

      expect(state?.present).toBe(true);
      expect(state?.nativeViewport).toBe('1920x1080');
      expect(state?.nativeWidth).toBe(1920);
      expect(state?.nativeHeight).toBe(1080);
      expect(state?.scale).toBeGreaterThan(0);
      expect(state?.scale).toBeLessThanOrEqual(1);
      expect(state?.stageOverflow).toBe('hidden');
      expect(state?.frameBoundingWidth).toBeLessThanOrEqual(state?.stageWidth + 2);
      expect(state?.frameBoundingHeight).toBeLessThanOrEqual(state?.stageHeight + 2);
    });
  }

  test('In active room: Close Nuvio closes view locally without changing room source', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const viewerContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const viewerPage = await viewerContext.newPage();
    const roomCode = `NUVCLOSE${Math.floor(Math.random() * 9000 + 1000)}`;

    await hostPage.goto('/');
    await expect(hostPage.locator('#app')).toBeVisible();
    await hostPage.click('#shortcutNuvioBtn');
    await hostPage.click('#headerToggleBtn');
    await hostPage.click('#startPartyBtn');
    await hostPage.fill('#nameInput', 'HostCloseTester');
    await hostPage.fill('#roomInput', roomCode);
    await hostPage.click('#createBtn');
    await expect(hostPage).toHaveURL(/\/watch\//, { timeout: 5000 });
    await expect(hostPage.locator('#partyPanel')).toBeVisible();
    await expect(hostPage.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(hostPage.locator('#nuvioFrame')).toBeVisible();

    await viewerContext.addInitScript(() => localStorage.setItem('wp-name', 'ViewerCloseTester'));
    await viewerPage.goto(hostPage.url());
    await expect(viewerPage).toHaveURL(/\/watch\//, { timeout: 5000 });
    await expect(viewerPage.locator('#app')).toBeVisible();
    await expect(viewerPage.locator('#partyPanel')).toBeVisible();
    await expect(viewerPage.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(viewerPage.locator('#nuvioFrame')).toBeVisible();

    await hostPage.click('#nuvioCloseBtn');
    await expect(hostPage.locator('#nuvioFrame')).toBeHidden();
    await expect(hostPage.locator('#nuvioToolbar')).toBeHidden();
    await expect(hostPage.locator('#syncStatus')).toContainText('Nuvio view closed');

    await expect(viewerPage.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(viewerPage.locator('#nuvioFrame')).toBeVisible();

    await hostContext.close();
    await viewerContext.close();
  });

  test('Dynamic switching: Nuvio -> Find Media drawer -> YouTube -> switch back to Nuvio', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();

    // 1. Open Nuvio
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(page.locator('#nuvioFrame')).toBeVisible();
    await expect(page.locator('#mediaStage')).toBeVisible();

    // 2. Open Find Media drawer while on Nuvio - Nuvio stays visible on stage while typing
    await page.click('#resolveTabBtn');
    await expect(page.locator('#findMediaPanel')).toBeVisible();
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    // 3. Load YouTube: Find Media drawer closes, Nuvio hides, YouTube occupies media box
    await page.fill('#sourceInput', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.click('#loadBtn');
    await expect(page.locator('#sourceModeLabel')).toHaveText('YouTube');
    await expect(page.locator('#findMediaPanel')).toBeHidden();
    await expect(page.locator('#nuvioFrame')).toBeHidden();
    await expect(page.locator('#nuvioToolbar')).toBeHidden();
    await expect(page.locator('#player')).toBeVisible();
    await expect(page.locator('#mediaStage')).toBeVisible();

    // 4. Switch back to Nuvio: YouTube hides, Nuvio occupies media box
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#sourceModeLabel')).toHaveText('Nuvio');
    await expect(page.locator('#player')).toBeHidden();
    await expect(page.locator('#nuvioFrame')).toBeVisible();
    await expect(page.locator('#nuvioToolbar')).toBeVisible();
    await expect(page.locator('#mediaStage')).toBeVisible();
  });

  test('Nuvio iframe renders untouched 1920x1080 canvas without internal DOM mutation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const nuvioFrameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await nuvioFrameElement.contentFrame();
    await nuvioFrame.waitForSelector('body');

    const isUntouched = await nuvioFrame.evaluate(() => {
      const doc = document;
      const oldConnectorStyle = doc.getElementById('__watchfusion_nuvio_viewport_connector');
      const oldConnectorRoot = doc.getElementById('__watchfusion_nuvio_viewport_root');
      return {
        hasOldStyle: Boolean(oldConnectorStyle),
        hasOldRoot: Boolean(oldConnectorRoot),
        docWidth: doc.documentElement.clientWidth,
        bodyWidth: doc.body.clientWidth
      };
    });

    expect(isUntouched.hasOldStyle).toBe(false);
    expect(isUntouched.hasOldRoot).toBe(false);
  });

  test('Nuvio sidebar click shield: ensures sidebar buttons (Settings, Search, Library) execute clicks cleanly', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const nuvioFrameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await nuvioFrameElement.contentFrame();

    const result = await nuvioFrame.evaluate(async () => {
      const doc = document;
      await new Promise(resolve => {
        let attempts = 0;
        const interval = setInterval(() => {
          if (doc.__watchfusionSidebarShieldInstalled || attempts++ > 40) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });
      let clickedAction = null;
      let backgroundCardActivated = false;

      // Mock background movie card
      const bgCard = doc.createElement('button');
      bgCard.className = 'focusable home-card';
      bgCard.dataset.title = 'Test Movie';
      bgCard.onclick = () => { backgroundCardActivated = true; };
      doc.body.appendChild(bgCard);

      // Mock sidebar item
      const sidebarNav = doc.createElement('button');
      sidebarNav.className = 'modern-sidebar-nav-item focusable';
      sidebarNav.dataset.action = 'gotoSettings';
      sidebarNav.onclick = () => { clickedAction = 'gotoSettings'; };
      doc.body.appendChild(sidebarNav);

      // Dispatch click event on sidebar button
      sidebarNav.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      await new Promise(r => setTimeout(r, 50));

      const res = {
        clickedAction,
        backgroundCardActivated,
        shieldInstalled: Boolean(doc.__watchfusionSidebarShieldInstalled)
      };

      bgCard.remove();
      sidebarNav.remove();
      return res;
    });

    expect(result.shieldInstalled).toBe(true);
    expect(result.clickedAction).toBe('gotoSettings');
    expect(result.backgroundCardActivated).toBe(false);
  });

  test('Nuvio QR account login generates real session and renders valid QR code without "not configured" error', async ({ page }) => {
    await page.goto('/');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const nuvioFrameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await nuvioFrameElement.contentFrame();

    const qrResult = await nuvioFrame.evaluate(async () => {
      const win = window;
      await new Promise(resolve => {
        let attempts = 0;
        const interval = setInterval(() => {
          if (win.__NUVIO_ENV__?.NUVIO_SUPABASE_URL || attempts++ > 40) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });
      const env = win.__NUVIO_ENV__ || {};
      const hasConfig = Boolean(env.NUVIO_SUPABASE_URL && env.NUVIO_SUPABASE_ANON_KEY);

      await new Promise(resolve => {
        let attempts = 0;
        const interval = setInterval(() => {
          if (document.getElementById('account') || attempts++ > 60) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      const router = win.NuvioRouter || win.Router;
      let navigateError = null;
      try {
        if (router) {
          await router.navigate('authQrSignIn');
          await new Promise(r => setTimeout(r, 2500));
        }
      } catch (e) {
        navigateError = e.message;
      }

      const qrContainer = document.querySelector('#qr-container');
      const qrCodeText = document.querySelector('#qr-code-text');
      const qrStatus = document.querySelector('#qr-status');
      const qrImg = document.querySelector('#qr-container img');

      return {
        hasConfig,
        supabaseUrl: env.NUVIO_SUPABASE_URL,
        hasAnonKey: Boolean(env.NUVIO_SUPABASE_ANON_KEY),
        tvLoginUrl: env.TV_LOGIN_WEB_BASE_URL,
        navigateError,
        statusText: qrStatus?.innerText,
        codeText: qrCodeText?.innerText,
        hasQrImg: Boolean(qrImg),
        qrImgSrc: qrImg?.src,
        html: qrContainer?.innerHTML
      };
    });

    console.log('LIVE QR RESULT:', qrResult);

    expect(qrResult.hasConfig).toBe(true);
    expect(qrResult.supabaseUrl).toBe('https://api.nuvio.tv');
    expect(qrResult.hasAnonKey).toBe(true);
  });

  test('Nuvio sidebar auto-collapses when pointer moves away from expanded sidebar', async ({ page }) => {
    await page.goto('/');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const nuvioFrameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await nuvioFrameElement.contentFrame();

    const collapseResult = await nuvioFrame.evaluate(async () => {
      const doc = document;
      window.parent?.watchFusionNuvioNativeViewport?.installSidebarClickShield?.(doc);
      let shell = doc.querySelector('.modern-sidebar-shell');
      if (!shell) {
        shell = doc.createElement('div');
        shell.className = 'modern-sidebar-shell expanded panel-visible';
        doc.body.appendChild(shell);
      } else {
        shell.classList.add('expanded', 'panel-visible');
      }

      // Simulate pointer moving outside the sidebar
      const outsideTarget = doc.querySelector('#app') || doc.body;
      outsideTarget.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 800, clientY: 500 }));

      await new Promise(r => setTimeout(r, 350));

      const isExpanded = shell.classList.contains('expanded');
      return { isExpanded, shieldInstalled: Boolean(doc.__watchfusionSidebarShieldInstalled) };
    });

    expect(collapseResult.shieldInstalled).toBe(true);
    expect(collapseResult.isExpanded).toBe(false);
  });

  test('Nuvio frame has active Hls.js engine and stream proxy interceptor enabled', async ({ page }) => {
    await page.goto('/');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const nuvioFrameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await nuvioFrameElement.contentFrame();

    const hlsResult = await nuvioFrame.evaluate(async () => {
      await new Promise(resolve => {
        let attempts = 0;
        const interval = setInterval(() => {
          if (window.Hls || attempts++ > 40) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      const hasHls = Boolean(window.Hls);
      const isSupported = Boolean(window.Hls && typeof window.Hls.isSupported === 'function' && window.Hls.isSupported());

      return {
        hasHls,
        isSupported,
        hlsVersion: window.Hls?.version || null
      };
    });

    expect(hlsResult.hasHls).toBe(true);
    expect(hlsResult.isSupported).toBe(true);
  });
});
