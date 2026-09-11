// Opt-in browser test: a completed assisted cache must replay without loading models.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const record = {};
  try {
    await page.goto(process.env.VOXELVISION_URL || 'http://127.0.0.1:9095');
    await page.waitForFunction(() => window.app?.depthData && window.app?.qualityGovernor);
    await page.evaluate(async () => {
      const { cacheIdForDescriptor, createDepthCacheDescriptor } = await import('/js/depth-cache-codec.js');
      const store = window.app.depthPlayback.controller.store;
      const sourceIdentity = 'test:completed-assisted-load';
      const descriptor = createDepthCacheDescriptor({
        sourceIdentity,
        duration: 12,
        width: 640,
        height: 360,
        cols: 128,
        rows: 72,
        fps: 3,
        modelKey: 'enhanced',
        backend: 'webgpu',
        precision: 'FP16 Hybrid',
        invert: false,
        conversionMode: 'fused',
        foregroundAssist: 'anime-v1'
      });
      const cacheId = cacheIdForDescriptor(descriptor);
      await store.initialize();
      await store.openVariant(cacheId, descriptor, {
        sourceIdentity,
        sourceTitle: 'Completed assisted load fixture',
        totalFrames: 36,
        frameCount: 36,
        analysisState: 'complete'
      });
      const frame = new Uint16Array(128 * 72).fill(24000);
      for (let index = 0; index < 36; index++) {
        await store.putFrame(cacheId, index, frame, { mediaTime: index / 3 });
      }
      await store.touchVariant(cacheId, { frameCount: 36, analysisState: 'complete' });
    });

    const started = Date.now();
    await page.evaluate(() => window.app.loadLiveMedia(
      '/media/voxelvision-demo.mp4?completed-assisted-load=1',
      'Completed assisted load fixture',
      { sourceIdentity: 'test:completed-assisted-load' }
    ));
    await page.waitForTimeout(250);
    await page.waitForFunction(() => {
      const controller = window.app.depthPlayback.controller;
      return controller.sourceReady && !controller.pumpPromise && !controller.pumpTimer
        && controller.snapshot().ramFrames >= 2 && window.app.scene.performanceMode === 'normal';
    }, null, { polling: 50, timeout: 30000 });
    record.state = await page.evaluate(async () => ({
      backend: window.app.liveDepth.backend,
      depthPipeline: Boolean(window.app.liveDepth.pipeline),
      maskEnabled: window.app.liveDepth.foregroundAssist.enabled,
      maskWorker: Boolean(window.app.liveDepth.foregroundAssist.worker),
      maskReady: window.app.liveDepth.foregroundAssist.ready,
      performanceMode: window.app.scene.performanceMode,
      pressureReasons: [...window.app.computePressureReasons],
      modelLoading: Boolean(window.app.liveDepth.loadPromise),
      firstRecord: Boolean(await window.app.depthPlayback.controller.store.getFrame(
        window.app.depthPlayback.controller.source?.cacheId,
        0
      )),
      cachedFrames: window.app.depthPlayback.controller.snapshot().cachedFrames,
      ramFrames: window.app.depthPlayback.controller.snapshot().ramFrames,
      cacheComplete: window.app.depthPlayback.controller.completedIndices.size === 36,
      controller: {
        frameCount: window.app.depthPlayback.controller.source?.frameCount,
        known: window.app.depthPlayback.controller.knownPersistent.size,
        completed: window.app.depthPlayback.controller.completedIndices.size,
        priorities: window.app.depthPlayback.controller.priorities.size,
        cursor: window.app.depthPlayback.controller.backgroundCursor,
        pumping: Boolean(window.app.depthPlayback.controller.pumpPromise)
      }
    }));
    record.loadMs = Date.now() - started;
    if (record.state.backend !== 'idle' || record.state.depthPipeline || record.state.maskWorker
      || record.state.maskReady || !record.state.maskEnabled || !record.state.cacheComplete
      || record.state.performanceMode !== 'normal') {
      throw new Error('completed assisted cache started an unnecessary model or did not restore completely');
    }
    console.log('Cache load responsiveness passed: completed assisted replay started no AI models.');
  } catch (error) {
    record.failure = error.message;
    record.failureState = await page.evaluate(() => {
      const app = window.app;
      const controller = app?.depthPlayback?.controller;
      return {
        sourceReady: controller?.sourceReady,
        pumping: Boolean(controller?.pumpPromise),
        pumpTimer: Boolean(controller?.pumpTimer),
        priorities: controller?.priorities?.size,
        ramFrames: controller?.snapshot?.().ramFrames,
        backend: app?.liveDepth?.backend,
        modelLoading: Boolean(app?.liveDepth?.loadPromise),
        maskWorker: Boolean(app?.liveDepth?.foregroundAssist?.worker),
        performanceMode: app?.scene?.performanceMode,
        reasons: [...(app?.computePressureReasons || [])]
      };
    }).catch(() => null);
    throw error;
  } finally {
    const dir = path.resolve(__dirname, '../test-results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache-load-responsiveness.json'), JSON.stringify(record));
    await browser.close();
  }
})().catch(error => {
  console.error(`cache-load-responsiveness: ${error.message}`);
  process.exitCode = 1;
});
