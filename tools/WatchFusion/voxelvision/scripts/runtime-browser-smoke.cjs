const { chromium } = require('playwright');

const BASE_URL = process.env.VOXELVISION_URL || 'http://127.0.0.1:9095';
const FIRST_VIDEO = process.env.VOXELVISION_VIDEO_A || '/media/voxelvision-demo.mp4?live-smoke=1';
const SECOND_VIDEO = process.env.VOXELVISION_VIDEO_B || '/media/voxelvision-demo.mp4?live-smoke=2';

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--enable-unsafe-webgpu', '--use-angle=d3d11']
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => consoleErrors.push(error.message));

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.app?.qualityGovernor, null, { timeout: 15000 });
    const controls = await page.evaluate(() => ({
      tuning: document.getElementById('qualityTuningMode').value,
      grid: document.getElementById('gridSelect').value,
      fps: document.getElementById('liveDepthRate').value,
      maxGridDisabled: document.querySelector('#gridSelect option[value="512"]').disabled
    }));
    if (controls.tuning !== 'manual') throw new Error(`Expected manual default, got ${controls.tuning}`);

    await page.selectOption('#gridSelect', '512');
    await page.selectOption('#liveDepthRate', '4');
    await page.evaluate(async source => {
      await window.app.loadLiveMedia(source, 'Runtime smoke: first source');
    }, FIRST_VIDEO);
    await page.waitForFunction(() => !document.getElementById('depthModeBadge').textContent.includes('Loading'), null, { timeout: 180000 });

    await page.evaluate(async () => {
      await window.app.video.play();
    });
    await page.waitForFunction(() => window.app.liveDepth.getDiagnostics()?.final?.length > 0, null, { timeout: 180000 });
    const enhanced = await page.evaluate(() => ({
      backend: window.app.liveDepth.backend,
      model: window.app.liveDepth.getActiveModelProfile()?.key,
      precision: window.app.liveDepth.precision,
      capture: [window.app.liveDepth.captureWidth, window.app.liveDepth.captureHeight],
      grid: [window.app.activeCols, window.app.activeRows],
      result: window.app.liveDepth.getLastResultMeta(),
      mode: window.app.qualityGovernor.snapshot()
    }));
    if (enhanced.backend !== 'webgpu' || enhanced.model !== 'enhanced') {
      throw new Error(`DA3 did not remain on WebGPU: ${enhanced.model}/${enhanced.backend}`);
    }
    if (enhanced.precision !== 'FP16 Hybrid') {
      throw new Error(`DA3 did not use its FP16 hybrid compatibility route: ${enhanced.precision}`);
    }
    if (Math.max(...enhanced.capture) < 512) {
      throw new Error(`DA3 high-detail capture was not exercised: ${enhanced.capture.join('x')}`);
    }

    await page.selectOption('#gridSelect', '128');
    await page.selectOption('#depthModelSelect', 'balanced');
    await page.waitForFunction(() => window.app.liveDepth.getActiveModelProfile()?.key === 'balanced', null, { timeout: 180000 });
    await page.evaluate(async () => {
      window.app.video.currentTime = 0;
      await window.app.video.play();
      window.app.liveDepth.requestImmediate({ resetTemporal: true });
    });
    await page.waitForFunction(() => window.app.liveDepth.getDiagnostics()?.metrics?.model?.active === 'balanced', null, { timeout: 180000 });
    const balanced = await page.evaluate(() => ({
      backend: window.app.liveDepth.backend,
      model: window.app.liveDepth.getActiveModelProfile()?.key,
      precision: window.app.liveDepth.precision,
      capture: [window.app.liveDepth.captureWidth, window.app.liveDepth.captureHeight],
      grid: [window.app.activeCols, window.app.activeRows],
      result: window.app.liveDepth.getLastResultMeta()
    }));
    if (balanced.capture[0] > 140 && balanced.capture[1] > 140) {
      throw new Error(`Reduced detail did not reach model input: ${balanced.capture.join('x')}`);
    }

    await page.evaluate(() => {
      window.__voxelVisionWarmPipeline = window.app.liveDepth.pipeline;
      window.app.video.pause();
    });
    await page.evaluate(async source => {
      await window.app.loadLiveMedia(source, 'Runtime smoke: second source');
    }, SECOND_VIDEO);
    const secondSource = await page.evaluate(() => ({
      badge: document.getElementById('depthModeBadge').textContent,
      samePipeline: window.__voxelVisionWarmPipeline === window.app.liveDepth.pipeline,
      backend: window.app.liveDepth.backend,
      model: window.app.liveDepth.getActiveModelProfile()?.key,
      sourceGeneration: window.app.sourceGeneration
    }));
    if (/Loading/i.test(secondSource.badge)) throw new Error('Second source remained in Loading state');
    if (!secondSource.samePipeline) throw new Error('Second source unnecessarily replaced the warm model');

    await page.selectOption('#gridSelect', '512');
    await page.selectOption('#liveDepthRate', '12');
    await page.selectOption('#qualityTuningMode', 'motion-priority');
    await page.evaluate(async () => {
      window.app.video.currentTime = 0;
      await window.app.video.play();
      window.app.liveDepth.requestImmediate({ resetTemporal: true });
    });
    await page.waitForFunction(
      () => window.app.liveDepth.getLastResultMeta()?.sourceGeneration === window.app.sourceGeneration,
      null,
      { timeout: 180000 }
    );
    await page.waitForFunction(
      () => window.app.qualityGovernor.snapshot().activeDetail < 512,
      null,
      { timeout: 180000 }
    );
    const adaptive = await page.evaluate(() => ({
      ...window.app.qualityGovernor.snapshot(),
      grid: [window.app.activeCols, window.app.activeRows],
      capture: [window.app.liveDepth.captureWidth, window.app.liveDepth.captureHeight],
      result: window.app.liveDepth.getLastResultMeta()
    }));
    if (adaptive.mode !== 'motion-priority') throw new Error('Motion-priority control did not become active');
    if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join('\n')}`);

    console.log(JSON.stringify({ controls, enhanced, balanced, secondSource, adaptive, consoleErrors }, null, 2));
  } catch (error) {
    const failureState = await page.evaluate(() => ({
      badge: document.getElementById('depthModeBadge')?.textContent,
      status: document.getElementById('statusMsg')?.textContent,
      paused: window.app?.video?.paused,
      currentTime: window.app?.video?.currentTime,
      backend: window.app?.liveDepth?.backend,
      model: window.app?.liveDepth?.getActiveModelProfile?.()?.key,
      diagnosticsModel: window.app?.liveDepth?.getDiagnostics?.()?.metrics?.model?.active,
      failures: window.app?.liveDepth?.consecutiveInferenceFailures
    }));
    console.error(JSON.stringify({ failureState, consoleErrors }, null, 2));
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
