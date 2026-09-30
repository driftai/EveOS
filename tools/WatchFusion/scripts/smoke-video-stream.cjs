const { chromium } = require('playwright');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const base = arg('--base', process.env.WATCHFUSION_URL || 'http://127.0.0.1:9087/');
const target = arg('--url', process.env.WATCHFUSION_VIDEO_URL || 'https://youtu.be/ds3sGeb8pK0?si=i9hCSJS7v2SLMYI7');
const seconds = Math.max(5, Math.min(120, Number(arg('--seconds', '20')) || 20));
const strict = args.includes('--strict');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [], requestFailures = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => {
    const url = request.url();
    if (/youtube|googlevideo|api\/media\/stream|voxelvision/i.test(url)) {
      requestFailures.push({ url: url.slice(0, 320), error: request.failure()?.errorText || '' });
    }
  });

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => globalThis.showFindMedia?.());
  await page.locator('#sourceInput').fill(target);
  await page.locator('#loadBtn').click();

  await page.waitForFunction(() => {
    const video = document.querySelector('#mediaVideo');
    const direct = video && video.readyState >= 1;
    const embed = globalThis.ytPlayerReady && globalThis.ytPlayer;
    return direct || embed;
  }, null, { timeout: 30000 });

  await page.evaluate(() => {
    const video = document.querySelector('#mediaVideo');
    globalThis.__wfVideoSmoke = { mode: video ? 'direct' : 'embed', events: [], samples: [], frames: 0, frameIntervals: [], lastFrameAt: 0 };
    if (video) {
      for (const name of ['waiting','stalled','playing','canplay','progress','suspend','error']) {
        video.addEventListener(name, () => globalThis.__wfVideoSmoke.events.push({ name, at: performance.now(), time: Number(video.currentTime) || 0 }), { passive:true });
      }
      if (typeof video.requestVideoFrameCallback === 'function') {
        const frame = now => {
          const diag = globalThis.__wfVideoSmoke;
          if (!diag) return;
          if (diag.lastFrameAt) diag.frameIntervals.push(now - diag.lastFrameAt);
          diag.lastFrameAt = now; diag.frames += 1;
          video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame);
      }
      video.play?.().catch(() => {});
    } else {
      try { globalThis.ytPlayer?.playVideo?.(); } catch {}
    }
    globalThis.__wfVideoSmoke.timer = setInterval(() => {
      const diag = globalThis.__wfVideoSmoke;
      if (diag.mode === 'direct') {
        diag.samples.push({ at:performance.now(), ...(globalThis.watchFusionMediaDiagnostics?.snapshot?.() || {}) });
      } else {
        diag.samples.push({
          at:performance.now(), kind:'youtube-embed',
          state:globalThis.ytPlayer?.getPlayerState?.(),
          currentTime:Number(globalThis.ytPlayer?.getCurrentTime?.())||0,
          loadedFraction:Number(globalThis.ytPlayer?.getVideoLoadedFraction?.())||0
        });
      }
    }, 250);
  });

  await page.waitForTimeout(seconds * 1000);
  const result = await page.evaluate(() => {
    clearInterval(globalThis.__wfVideoSmoke.timer);
    const diag = globalThis.__wfVideoSmoke;
    const samples = diag.samples;
    let activePairs=0, stalledPairs=0;
    for (let i=1;i<samples.length;i+=1) {
      const a=samples[i-1], b=samples[i];
      const aTime=Number(a.currentTime)||0, bTime=Number(b.currentTime)||0;
      const active = diag.mode === 'direct' ? !a.paused && a.readyState >= 2 : a.state === 1;
      if (!active) continue;
      activePairs += 1;
      if (bTime - aTime < 0.05) stalledPairs += 1;
    }
    const first=samples[0]||{}, last=samples.at(-1)||{};
    const intervals=diag.frameIntervals.slice(-500);
    const avgFrameMs=intervals.length?intervals.reduce((sum,value)=>sum+value,0)/intervals.length:null;
    const waits=diag.events.filter(event=>event.name==='waiting'||event.name==='stalled');
    return {
      mode:diag.mode,
      elapsedPlaybackSec:Math.max(0,(Number(last.currentTime)||0)-(Number(first.currentTime)||0)),
      activePairs, stalledPairs, stalledRatio:activePairs?stalledPairs/activePairs:0,
      frameCount:diag.frames,
      avgFrameMs,
      approxPresentedFps:avgFrameMs?1000/avgFrameMs:null,
      waitingOrStalledEvents:waits,
      start:first, end:last,
      hls:last.hls||null,
      droppedFrameRatio:last.totalFrames?last.droppedFrames/last.totalFrames:0,
      eventCounts:diag.events.reduce((out,event)=>{out[event.name]=(out[event.name]||0)+1;return out;},{}),
      sampleTail:samples.slice(-8)
    };
  });

  const health = result.elapsedPlaybackSec >= seconds * 0.65 && result.stalledRatio < 0.25 ? 'good' : 'degraded';
  console.log(JSON.stringify({ smoke:'watchfusion-video-stream', target, seconds, health, result,
    consoleErrors:consoleErrors.slice(0,20), requestFailures:requestFailures.slice(0,20) }, null, 2));
  console.log(`WATCHFUSION_VIDEO_STREAM_SMOKE_${health === 'good' ? 'OK' : 'DEGRADED'}`);
  await browser.close();
  if (strict && health !== 'good') process.exitCode = 1;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
