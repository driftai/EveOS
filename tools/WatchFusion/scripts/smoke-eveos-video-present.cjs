const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  sleep,
  formatTime,
  summarizeIntervals,
  playbackSnapshot,
  waitForPlayable,
  outerLayoutSnapshot,
  innerLayoutSnapshot,
  installDiagnostics,
  collectDiagnostics,
  analyzeSamples
} = require('./smoke-eveos-video-present-helpers.cjs');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const requestedEveosUrl = arg('--eveos', process.env.EVEOS_URL || '');
const target = arg('--url', process.env.WATCHFUSION_VIDEO_URL || 'https://youtu.be/ds3sGeb8pK0?si=i9hCSJS7v2SLMYI7');
const seconds = Math.max(5, Math.min(900, Number(arg('--seconds', '20')) || 20));
const headedOnly = args.includes('--headed');
const headlessOnly = args.includes('--headless');
const both = args.includes('--both') || (headedOnly && headlessOnly);
const runModes = both ? [false, true] : headedOnly ? [true] : [false];
const untilEnded = args.includes('--until-ended');
const maxSeconds = Math.max(
  seconds,
  Math.min(1800, Number(arg('--max-seconds', String(Math.max(seconds, 900)))) || Math.max(seconds, 900))
);
const channel = arg('--channel', process.env.PW_BROWSER_CHANNEL || '');
const strict = args.includes('--strict');
const progressEverySec = Math.max(2, Math.min(60, Number(arg('--progress-every', '10')) || 10));

const repoRoot = path.resolve(__dirname, '../../..');

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}
function readPortRegistry() {
  return readJson(path.join(repoRoot, 'config', 'eveos-ports.json'))?.ports || {};
}
function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}
function configuredPort(name, fallback = 0) {
  return validPort(readPortRegistry()?.[name]?.port) || validPort(fallback);
}
function readLastLauncherPort() {
  try {
    return validPort(fs.readFileSync(
      path.join(repoRoot, 'data', 'runtime', 'eveos-last-launcher-port.txt'),
      'utf8'
    ).trim());
  } catch { return 0; }
}

async function resolveEveosUrl() {
  if (requestedEveosUrl) return requestedEveosUrl;
  const controlPort = configuredPort('GEMINI_CONTROL_PORT', 9082);
  if (controlPort) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${controlPort}/api/control-plane/status`,
        { cache:'no-store', signal:AbortSignal.timeout(1500) }
      );
      const payload = await response.json();
      const activePort = validPort(payload?.web?.port);
      if (response.ok && payload?.service === 'eveos-control-plane'
          && payload?.web?.running === true && activePort) {
        return `http://127.0.0.1:${activePort}/EveOS.html`;
      }
    } catch {}
  }
  const fallbackPort = readLastLauncherPort() || configuredPort('EVEOS_WEB_PORT', 8765) || 3000;
  return `http://127.0.0.1:${fallbackPort}/EveOS.html`;
}

function stage(mode, message) {
  console.log(`[watchfusion-video][${mode}] ${message}`);
}

function playbackProgressLine(snapshot) {
  if (!snapshot) return 'playback unavailable';
  const total = Number(snapshot.duration) || 0;
  const current = Number(snapshot.currentTime) || 0;
  const pct = total > 0 ? ` ${Math.min(100, (current / total) * 100).toFixed(1)}%` : '';
  return `${snapshot.mode || 'unknown'} ${formatTime(current)}/${total ? formatTime(total) : '?'}${pct} state=${snapshot.stateName || 'n/a'}`;
}

async function waitForPlaybackWindow(page, frame, mode) {
  const limitMs = (untilEnded ? maxSeconds : seconds) * 1000;
  const started = Date.now();
  let lastProgress = -Infinity;
  let ended = false;

  while (Date.now() - started < limitMs) {
    const elapsedMs = Date.now() - started;
    if (elapsedMs - lastProgress >= progressEverySec * 1000) {
      lastProgress = elapsedMs;
      const snap = await playbackSnapshot(frame).catch(() => null);
      stage(mode, `playback: ${playbackProgressLine(snap)}`);
    }

    if (untilEnded) {
      const snap = await playbackSnapshot(frame).catch(() => null);
      if (snap?.ended) {
        ended = true;
        stage(mode, `end detected at ${formatTime(snap.currentTime)} / ${formatTime(snap.duration)}`);
        break;
      }
    } else if (elapsedMs >= seconds * 1000) {
      break;
    }

    await page.waitForTimeout(500);
  }

  if (untilEnded && !ended) {
    const snap = await playbackSnapshot(frame).catch(() => null);
    stage(mode, `end not observed before ${maxSeconds}s ceiling; last=${playbackProgressLine(snap)}`);
  }

  return ended;
}

async function runPass(headed) {
  const mode = headed ? 'headed' : 'headless';
  const eveosUrl = await resolveEveosUrl();
  const launchOptions = { headless: !headed };
  if (channel) launchOptions.channel = channel;

  let browser = null;
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];

  try {
    stage(mode, `launching ${channel || 'bundled Chromium'} via Playwright (${headed ? 'visible' : 'headless'})`);
    browser = await chromium.launch(launchOptions);
    const browserVersion = browser.version();
    stage(mode, `browser ready: ${browserVersion}`);

    const page = await browser.newPage({ viewport:{ width:1600, height:1000 } });
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => {
      const url = request.url();
      if (/youtube|googlevideo|api\/media\/stream|voxelvision/i.test(url)) {
        requestFailures.push({ url:url.slice(0,320), error:request.failure()?.errorText || '' });
      }
    });

    stage(mode, `opening EveOS: ${eveosUrl}`);
    await page.goto(eveosUrl, { waitUntil:'domcontentloaded', timeout:120000 });
    await page.waitForFunction(
      () => window.EveWatchFusion?.ready && typeof window.EveWatchFusion.open === 'function',
      null,
      { timeout:120000 }
    );
    stage(mode, 'EveOS WatchFusion bridge ready');

    await page.evaluate(() => window.EveWatchFusion.open());
    await page.waitForSelector('#watchfusion-overlay .watchfusion-frame:not([hidden])', { timeout:30000 });
    stage(mode, 'WatchFusion overlay opened');

    const handle = await page.locator('#watchfusion-overlay .watchfusion-frame').elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error('WatchFusion iframe was not available inside EveOS.');

    await frame.waitForFunction(
      () => document.readyState === 'complete' || document.readyState === 'interactive',
      null,
      { timeout:30000 }
    );
    stage(mode, 'WatchFusion iframe ready');

    await frame.evaluate(() => globalThis.showFindMedia?.());
    await frame.locator('#sourceInput').fill(target);
    await frame.locator('#loadBtn').click();
    stage(mode, 'source submitted; waiting for native YouTube or direct-video player');

    const readySnapshot = await waitForPlayable(frame, 60000, message => stage(mode, message));
    if (!readySnapshot?.ready) {
      const layout = await innerLayoutSnapshot(frame).catch(() => null);
      throw new Error(
        `WatchFusion player did not become ready within 60s. PLAYER_STATE=${JSON.stringify(readySnapshot)} LAYOUT=${JSON.stringify(layout)}`
      );
    }
    stage(mode, `player ready: ${playbackProgressLine(readySnapshot)}`);

    const layoutStart = {
      outer: await outerLayoutSnapshot(page),
      inner: await innerLayoutSnapshot(frame)
    };

    await installDiagnostics(page, frame);
    stage(mode, `diagnostics armed; ${untilEnded ? `watching until media ends (ceiling ${maxSeconds}s)` : `sampling for ${seconds}s`}`);

    const endedObserved = await waitForPlaybackWindow(page, frame, mode);
    if (untilEnded) await page.waitForTimeout(350);

    stage(mode, 'collecting presentation and layout snapshots');
    const layoutEnd = {
      outer: await outerLayoutSnapshot(page),
      inner: await innerLayoutSnapshot(frame)
    };
    const { outer, inner } = await collectDiagnostics(page, frame);

    const outerRaf = summarizeIntervals(outer.raf);
    const innerRaf = summarizeIntervals(inner.raf);
    const innerFrames = summarizeIntervals(inner.frames);
    const sampleAnalysis = analyzeSamples(inner.samples);
    const waiting = inner.events.filter(event => event.name === 'waiting' || event.name === 'stalled');
    const direct = inner.end.mode === 'direct';
    const droppedRatio = direct && inner.end.totalFrames
      ? Number(inner.end.droppedFrames || 0) / Number(inner.end.totalFrames)
      : null;
    const outerLongMs = outer.longTasks.reduce((sum,item) => sum + Number(item.duration || 0), 0);
    const innerLongMs = inner.longTasks.reduce((sum,item) => sum + Number(item.duration || 0), 0);
    const maxGapAllowance = Math.max(2, Math.ceil(Math.max(seconds, inner.elapsedPlaybackSec) / 30));
    const expectedWindow = untilEnded ? Math.min(20, Math.max(5, inner.end.duration || 20)) : seconds;
    const healthyPlayback = untilEnded
      ? endedObserved
      : inner.elapsedPlaybackSec >= expectedWindow * 0.65 && sampleAnalysis.stalledRatio < 0.25;
    const presentationGapCount = direct ? innerFrames.over100Ms : innerRaf.over100Ms;
    const healthyPresentation = outerRaf.over100Ms <= maxGapAllowance
      && presentationGapCount <= maxGapAllowance
      && (droppedRatio == null || droppedRatio < 0.08);
    const health = healthyPlayback && healthyPresentation ? 'good' : 'degraded';

    return {
      smoke:'watchfusion-eveos-video-present',
      mode,
      eveosUrl,
      target,
      seconds,
      untilEnded,
      maxSeconds,
      headed,
      browser:{ engine:'chromium', channel:channel || 'bundled-chromium', version:browserVersion },
      health,
      playback:{
        mediaMode:inner.end.mode || readySnapshot.mode || null,
        elapsedPlaybackSec:inner.elapsedPlaybackSec,
        endedObserved,
        waitingOrStalledEvents:waiting,
        eventCounts:inner.events.reduce((out,event) => {
          out[event.name] = (out[event.name] || 0) + 1;
          return out;
        }, {}),
        stalledPairs:sampleAnalysis.stalledPairs,
        activePairs:sampleAnalysis.activePairs,
        stalledRatio:sampleAnalysis.stalledRatio,
        bufferingSamples:sampleAnalysis.bufferingSamples,
        droppedFrameRatio:droppedRatio,
        start:inner.start,
        end:inner.end
      },
      presentation:{
        outerRaf,
        innerRaf,
        innerVideoFrames:direct ? innerFrames : null,
        note:direct ? null : 'Native YouTube iframe is cross-origin; requestVideoFrameCallback is unavailable, so inner RAF + YouTube timeline/state are used instead.',
        outerLongTasks:outer.longTasks.slice(-20),
        innerLongTasks:inner.longTasks.slice(-20),
        outerLongTaskMs:outerLongMs,
        innerLongTaskMs:innerLongMs
      },
      layout:{ start:layoutStart, end:layoutEnd },
      requestFailures:requestFailures.slice(0,20),
      consoleErrors:consoleErrors.slice(0,20),
      pageErrors:pageErrors.slice(0,20)
    };
  } finally {
    if (browser) {
      stage(mode, 'closing Playwright browser');
      await browser.close().catch(() => {});
    }
  }
}

(async () => {
  const results = [];
  for (const headed of runModes) {
    const mode = headed ? 'headed' : 'headless';
    console.log(`WATCHFUSION_EVEOS_VIDEO_PRESENT_START ${mode}`);
    try {
      const result = await runPass(headed);
      results.push(result);
      console.log(JSON.stringify(result, null, 2));
      console.log(`WATCHFUSION_EVEOS_VIDEO_PRESENT_${mode.toUpperCase()}_${result.health === 'good' ? 'OK' : 'DEGRADED'}`);
    } catch (error) {
      const failed = {
        smoke:'watchfusion-eveos-video-present',
        mode,
        health:'error',
        error:error.stack || String(error)
      };
      results.push(failed);
      console.error(JSON.stringify(failed, null, 2));
    }
  }

  const overall = results.every(result => result.health === 'good') ? 'good' : 'degraded';
  if (runModes.length > 1) {
    console.log(JSON.stringify({
      smoke:'watchfusion-eveos-video-present-matrix',
      target,
      seconds,
      untilEnded,
      maxSeconds,
      channel:channel || null,
      health:overall,
      modes:results.map(result => ({
        mode:result.mode,
        health:result.health,
        mediaMode:result.playback?.mediaMode ?? null,
        elapsedPlaybackSec:result.playback?.elapsedPlaybackSec ?? null,
        endedObserved:result.playback?.endedObserved ?? null,
        outerWorstRafMs:result.presentation?.outerRaf?.worstMs ?? null,
        innerWorstRafMs:result.presentation?.innerRaf?.worstMs ?? null,
        innerWorstFrameMs:result.presentation?.innerVideoFrames?.worstMs ?? null,
        droppedFrameRatio:result.playback?.droppedFrameRatio ?? null,
        error:result.error || null
      }))
    }, null, 2));
    console.log(`WATCHFUSION_EVEOS_VIDEO_PRESENT_MATRIX_${overall === 'good' ? 'OK' : 'DEGRADED'}`);
  }

  if (strict && overall !== 'good') process.exitCode = 1;
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
