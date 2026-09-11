// Opt-in GPU/model-download test. Uses an isolated Chrome profile.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'] });
  const page = await browser.newPage();
  const record = { errors: [] };
  page.on('pageerror', error => record.errors.push(error.message));
  try {
    await page.goto(process.env.VOXELVISION_URL || 'http://127.0.0.1:9095');
    await page.waitForFunction(() => window.app?.qualityGovernor && window.app.depthData && window.app.video.readyState >= 2);
    await page.selectOption('#foregroundAssist', 'anime');
    record.deferredBeforeVideo = await page.evaluate(() => !window.app.liveDepth.foregroundAssist.worker);
    if (!record.deferredBeforeVideo) throw new Error('optional model started before a live assisted analysis required it');
    await page.selectOption('#gridSelect', '512');
    await page.evaluate(async src => {
      await window.app.loadLiveMedia(src, 'Assisted depth regression', { sourceIdentity: 'test:assisted-cache' });
      window.app.video.muted = true;
      window.app.video.currentTime = Math.min(2, window.app.video.duration / 2);
    }, process.env.VOXELVISION_VIDEO_A || '/media/voxelvision-demo.mp4');
    await page.waitForFunction(() => window.app.liveDepth.foregroundAssist.ready, null, { timeout: 150000 });
    await page.waitForFunction(() => window.app.depthPlayback.controller.snapshot().nativeFrames >= 4, null, { timeout: 60000 });
    record.analysis = await page.evaluate(async () => {
      const app = window.app, controller = app.depthPlayback.controller;
      const session = await controller.store.getSession(controller.source.cacheId);
      const first = [...controller.knownPersistent][0];
      const frame = await controller.store.getFrame(session.id, first);
      return { backend: app.liveDepth.backend, precision: app.liveDepth.precision,
        mask: session.descriptor.foregroundAssist, nativeFrames: controller.snapshot().nativeFrames,
        storedBytes: frame.data.byteLength, expectedBytes: session.descriptor.cols * session.descriptor.rows * 2,
        error: app.video.error?.message || null };
    });
    if (record.analysis.backend !== 'webgpu' || record.analysis.precision !== 'FP16 Hybrid'
      || record.analysis.mask !== 'anime-v1' || record.analysis.storedBytes !== record.analysis.expectedBytes
      || record.analysis.error || record.errors.length) throw new Error('Assisted analysis/cache invariant failed');
    for (let cycle = 0; cycle < 20; cycle++) {
      await page.evaluate(cycle => { window.app.video.currentTime = cycle % 2 ? 0 : 2; }, cycle);
      await page.waitForFunction(() => !window.app.video.seeking && !window.app.depthPlayback.controller.playbackSeeking, null, { timeout: 10000 });
    }
    await page.evaluate(() => window.app.video.play());
    await page.waitForFunction(() => window.app.video.currentTime > 0.4 && !window.app.video.error);
    record.aiSeekCycles = 20;
    console.log('Assisted depth runtime passed: DA3 WebGPU FP16, optional mask worker and persistent 16-bit cache.');
  } catch (error) {
    record.failure = error.message;
    record.runtime = await page.evaluate(() => ({ state: window.app.depthPlayback.controller.snapshot(),
      source: window.app.depthPlayback.controller.source?.descriptor,
      pending: Boolean(window.app.depthPlayback.controller.pumpPromise),
      seeking: window.app.depthPlayback.controller.playbackSeeking,
      video: { time: window.app.video.currentTime, seeking: window.app.video.seeking, ready: window.app.video.readyState, error: window.app.video.error?.message },
      mask: { enabled: window.app.liveDepth.foregroundAssist.enabled, ready: window.app.liveDepth.foregroundAssist.ready, loading: Boolean(window.app.liveDepth.foregroundAssist.finishLoading) },
      badge: document.getElementById('depthModeBadge').textContent,
      cacheStatus: document.getElementById('hybridDepthStatus')?.textContent
    })).catch(() => null);
    throw error;
  }
  finally {
    const dir = path.resolve(__dirname, '../test-results'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'assisted-depth-runtime.json'), JSON.stringify(record));
    await browser.close();
  }
})().catch(error => { console.error('assisted-depth-runtime:', error.message); process.exitCode = 1; });
