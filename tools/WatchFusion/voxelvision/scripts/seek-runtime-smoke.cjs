// Opt-in Chrome test. Set VOXELVISION_VIDEO_A to a locally imported MP4 to
// exercise the exact imported-media route. No download or user cache required.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  const diagnostics = { errors: [], cycles: 0 };
  page.on('pageerror', error => diagnostics.errors.push(error.message));
  try {
    await page.goto(process.env.VOXELVISION_URL || 'http://127.0.0.1:9095');
    await page.waitForFunction(() => window.app?.qualityGovernor && window.app.depthData && window.app.video.readyState >= 2);
    await page.evaluate(async src => {
      const app = window.app;
      app.video.muted = true;
      await app.depthPlayback.setConversionMode('luma', { load: false, reconfigure: false });
      await app.loadLiveMedia(src, 'Seek regression fixture', { sourceIdentity: 'test:seek-fixture' });
      await app.video.play();
    }, process.env.VOXELVISION_VIDEO_A || '/media/voxelvision-demo.mp4');
    await page.waitForFunction(() => window.app.depthPlayback.controller.source && !window.app.depthPlayback.restartTimer);
    await page.evaluate(() => {
      window.seekIdentity = window.app.depthPlayback.controller.source.cacheId;
      window.seekSource = window.app.video.getAttribute('src');
    });
    for (let cycle = 0; cycle < 25; cycle++) {
      await page.evaluate(async cycle => {
        const app = window.app, video = app.video, bar = document.getElementById('seekBar');
        const before = video.currentTime;
        for (let i = 0; i < 40; i++) {
          bar.value = String((i * 7 + cycle) % 90);
          bar.dispatchEvent(new Event('input'));
        }
        if (Math.abs(video.currentTime - before) > 0.5) throw new Error('Scrub burst hammered decoder');
        bar.value = cycle % 2 ? '0' : '12';
        bar.dispatchEvent(new Event('change'));
      }, cycle);
      await page.waitForFunction(() => !window.app.video.seeking && !window.app.isSeeking, null, { timeout: 15000 });
      await page.evaluate(async () => {
        const app = window.app;
        if (app.video.error) throw new Error(app.video.error.message);
        if (app.video.getAttribute('src') !== window.seekSource) throw new Error('Source changed');
        if (app.depthPlayback.controller.source.cacheId !== window.seekIdentity) throw new Error('Cache identity changed');
        await app.video.play();
      });
      diagnostics.cycles++;
    }
    await page.evaluate(async () => { await window.app.mediaHealth.recover(); });
    await page.waitForFunction(() => !window.app.video.seeking && !window.app.video.paused);
    const time = await page.evaluate(() => window.app.video.currentTime);
    await page.waitForFunction(time => window.app.video.currentTime > time + 0.3, time);
    await page.waitForFunction(() => window.app.depthPlayback.controller.snapshot().nativeFrames > 5);
    diagnostics.result = await page.evaluate(() => ({
      error: window.app.video.error?.message || null,
      sameSource: window.app.video.getAttribute('src') === window.seekSource,
      sameCache: window.app.depthPlayback.controller.source.cacheId === window.seekIdentity,
      analyzerPaused: window.app.depthPlayback.controller.playbackSeeking,
      nativeFrames: window.app.depthPlayback.controller.snapshot().nativeFrames
    }));
    if (diagnostics.result.error || !diagnostics.result.sameSource || !diagnostics.result.sameCache || diagnostics.result.analyzerPaused || diagnostics.errors.length) throw new Error('Seek/recovery invariant failed');
    await page.evaluate(async () => {
      const coordinator = window.app.depthPlayback;
      const store = coordinator.controller.store;
      const current = await store.getSession(window.seekIdentity);
      await store.openVariant('retained-sibling', { ...current.descriptor, fps: current.descriptor.fps + 1 }, { sourceIdentity: current.sourceIdentity });
      await coordinator.deleteProfile(window.seekIdentity);
      if (coordinator.mode !== 'live' || coordinator.controller.source) throw new Error('Deleted profile analyzer remained active');
      if (await store.getSession(window.seekIdentity)) throw new Error('Active profile was not removed');
      if (!(await store.getSession('retained-sibling'))) throw new Error('Sibling profile removed');
      if (window.app.video.getAttribute('src') !== window.seekSource) throw new Error('Deleting profile changed video');
    });
    await page.waitForTimeout(250);
    if (await page.evaluate(() => window.app.depthPlayback.controller.store.getSession(window.seekIdentity))) throw new Error('Background work recreated deleted profile');
    console.log('Seek runtime smoke passed: 25 scrub/replay cycles, local recovery and hybrid cache preserved.');
  } catch (error) { diagnostics.failure = error.message; throw error; }
  finally {
    const dir = path.resolve(__dirname, '../test-results'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'seek-runtime.json'), JSON.stringify(diagnostics));
    await browser.close();
  }
})().catch(error => { console.error('seek-runtime:', error.message); process.exitCode = 1; });
