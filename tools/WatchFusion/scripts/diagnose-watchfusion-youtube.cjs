const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [], requestFailures = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText || '' }));
  await page.goto('http://127.0.0.1:9087/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => globalThis.showFindMedia?.());
  await page.locator('#sourceInput').fill('https://youtu.be/ds3sGeb8pK0?si=i9hCSJS7v2SLMYI7');
  await page.locator('#loadBtn').click();
  try {
    await page.waitForFunction(() => globalThis.ytPlayerReady && globalThis.ytPlayer?.getVideoData?.()?.video_id === 'ds3sGeb8pK0', null, { timeout: 15000 });
  } catch (error) {
    console.log(JSON.stringify({ readiness: await page.evaluate(() => ({
      status: document.querySelector('#syncStatus')?.textContent,
      source: globalThis.state?.source || null,
      ready: globalThis.ytPlayerReady,
      player: !!globalThis.ytPlayer,
      iframe: document.querySelector('#player iframe')?.src || null
    })), consoleErrors, requestFailures }, null, 2));
    throw error;
  }
  await page.evaluate(() => {
    globalThis.__wfDiag = { calls: [], samples: [], transitions: [], longTasks: [], renders: 0, ensures: 0 };
    const originalRender = globalThis.render;
    globalThis.render = (...args) => { globalThis.__wfDiag.renders += 1; return originalRender(...args); };
    const originalEnsure = globalThis.ensurePlayer;
    globalThis.ensurePlayer = (...args) => { globalThis.__wfDiag.ensures += 1; return originalEnsure(...args); };
    for (const name of ['playVideo', 'pauseVideo', 'seekTo', 'cueVideoById', 'loadVideoById', 'setPlaybackRate']) {
      const original = globalThis.ytPlayer?.[name];
      if (typeof original !== 'function') continue;
      globalThis.ytPlayer[name] = (...args) => {
        globalThis.__wfDiag.calls.push({ name, args, at: performance.now() });
        return original.apply(globalThis.ytPlayer, args);
      };
    }
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) globalThis.__wfDiag.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
    let prior = null;
    globalThis.__wfDiag.timer = setInterval(() => {
      const state = globalThis.ytPlayer?.getPlayerState?.();
      if (state !== prior) globalThis.__wfDiag.transitions.push({ state, at: performance.now() });
      prior = state;
      globalThis.__wfDiag.samples.push({
        at: performance.now(), state,
        time: Number(globalThis.ytPlayer?.getCurrentTime?.()) || 0,
        loaded: Number(globalThis.ytPlayer?.getVideoLoadedFraction?.()) || 0
      });
    }, 250);
  });
  await page.waitForTimeout(20000);
  const result = await page.evaluate(() => {
    clearInterval(globalThis.__wfDiag.timer);
    const samples = globalThis.__wfDiag.samples;
    let playingSamples = 0, stalledPlayingSamples = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index - 1].state !== 1 || samples[index].state !== 1) continue;
      playingSamples += 1;
      if (samples[index].time - samples[index - 1].time < 0.05) stalledPlayingSamples += 1;
    }
    return {
      linked: globalThis.watchFusionLinkedTab?.active?.() || false,
      roomId: globalThis.roomId || null,
      source: globalThis.state?.source || null,
      playerState: globalThis.ytPlayer?.getPlayerState?.(),
      playerTime: globalThis.ytPlayer?.getCurrentTime?.(),
      loadedFraction: globalThis.ytPlayer?.getVideoLoadedFraction?.(),
      calls: globalThis.__wfDiag.calls,
      transitions: globalThis.__wfDiag.transitions,
      longTasks: globalThis.__wfDiag.longTasks,
      renders: globalThis.__wfDiag.renders,
      ensures: globalThis.__wfDiag.ensures,
      playingSamples,
      stalledPlayingSamples,
      sampleTail: samples.slice(-12)
    };
  });
  console.log(JSON.stringify({ result, consoleErrors, requestFailures: requestFailures.slice(0, 20) }, null, 2));
  await page.screenshot({ path: 'output/playwright/watchfusion-youtube-diagnose.png', fullPage: true });
  await browser.close();
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
