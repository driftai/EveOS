const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

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

const repoRoot = path.resolve(__dirname, '../../..');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
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
  } catch {
    return 0;
  }
}

async function resolveEveosUrl() {
  if (requestedEveosUrl) return requestedEveosUrl;

  const controlPort = configuredPort('GEMINI_CONTROL_PORT', 9082);
  if (controlPort) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${controlPort}/api/control-plane/status`,
        { cache: 'no-store', signal: AbortSignal.timeout(1500) }
      );
      const payload = await response.json();
      const activePort = validPort(payload?.web?.port);
      if (response.ok && payload?.service === 'eveos-control-plane'
          && payload?.web?.running === true && activePort) {
        return `http://127.0.0.1:${activePort}/EveOS.html`;
      }
    } catch {}
  }

  const fallbackPort = readLastLauncherPort()
    || configuredPort('EVEOS_WEB_PORT', 8765)
    || 3000;
  return `http://127.0.0.1:${fallbackPort}/EveOS.html`;
}

function summarizeIntervals(values) {
  if (!values.length) return { count:0, avgMs:null, p95Ms:null, worstMs:null, over50Ms:0, over100Ms:0 };
  const sorted=[...values].sort((a,b)=>a-b);
  const pick=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
  return {
    count:values.length,
    avgMs:values.reduce((sum,value)=>sum+value,0)/values.length,
    p95Ms:pick(.95),
    worstMs:sorted.at(-1),
    over50Ms:values.filter(value=>value>50).length,
    over100Ms:values.filter(value=>value>100).length
  };
}

function rectSnapshot(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    right: rect.right, bottom: rect.bottom,
    display: style.display, position: style.position,
    overflow: style.overflow, overflowX: style.overflowX, overflowY: style.overflowY
  };
}

async function outerLayoutSnapshot(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('#watchfusion-overlay');
    const frame = document.querySelector('#watchfusion-overlay .watchfusion-frame');
    const root = document.documentElement;
    const body = document.body;
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      root: {
        clientWidth: root.clientWidth, clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight
      },
      body: body ? {
        clientWidth: body.clientWidth, clientHeight: body.clientHeight,
        scrollWidth: body.scrollWidth, scrollHeight: body.scrollHeight
      } : null,
      overlay: (() => {
        if (!overlay) return null;
        const rect = overlay.getBoundingClientRect();
        const style = getComputedStyle(overlay);
        return {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          right: rect.right, bottom: rect.bottom,
          display: style.display, position: style.position,
          overflow: style.overflow, overflowX: style.overflowX, overflowY: style.overflowY
        };
      })(),
      frame: (() => {
        if (!frame) return null;
        const rect = frame.getBoundingClientRect();
        const style = getComputedStyle(frame);
        return {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          right: rect.right, bottom: rect.bottom,
          display: style.display, position: style.position,
          overflow: style.overflow, overflowX: style.overflowX, overflowY: style.overflowY
        };
      })()
    };
  });
}

async function innerLayoutSnapshot(frame) {
  return frame.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const video = document.querySelector('#mediaVideo');
    const oversized = [...document.querySelectorAll('body *')].map(element => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      if (rect.right <= innerWidth + 2 && rect.bottom <= innerHeight + 2
          && rect.width <= innerWidth + 2 && rect.height <= innerHeight + 2) return null;
      return {
        tag: element.tagName,
        id: element.id || '',
        className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom
      };
    }).filter(Boolean).slice(0, 12);
    const snapRect = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        right: rect.right, bottom: rect.bottom,
        display: style.display, position: style.position,
        overflow: style.overflow, overflowX: style.overflowX, overflowY: style.overflowY
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      root: {
        clientWidth: root.clientWidth, clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight
      },
      body: body ? {
        clientWidth: body.clientWidth, clientHeight: body.clientHeight,
        scrollWidth: body.scrollWidth, scrollHeight: body.scrollHeight
      } : null,
      video: snapRect(video),
      videoState: video ? {
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        ended: video.ended,
        currentTime: Number(video.currentTime) || 0,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        currentSrc: video.currentSrc || video.src || ''
      } : null,
      oversized
    };
  });
}

async function runPass(headed) {
  const eveosUrl = await resolveEveosUrl();
  const launchOptions = { headless: !headed };
  if (channel) launchOptions.channel = channel;
  let browser = null;
  const consoleErrors = [], pageErrors = [], requestFailures = [];

  try {
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport:{ width:1600, height:1000 } });
    page.on('console', message => { if(message.type()==='error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => {
      const url = request.url();
      if (/youtube|googlevideo|api\/media\/stream|voxelvision/i.test(url)) {
        requestFailures.push({ url:url.slice(0,320), error:request.failure()?.errorText || '' });
      }
    });

    await page.goto(eveosUrl,{ waitUntil:'domcontentloaded', timeout:120000 });
    await page.waitForFunction(
      () => window.EveWatchFusion?.ready && typeof window.EveWatchFusion.open === 'function',
      null,
      { timeout:120000 }
    );
    await page.evaluate(() => window.EveWatchFusion.open());
    await page.waitForSelector('#watchfusion-overlay .watchfusion-frame:not([hidden])',{ timeout:30000 });

    const handle = await page.locator('#watchfusion-overlay .watchfusion-frame').elementHandle();
    const frame = await handle?.contentFrame();
    if(!frame) throw new Error('WatchFusion iframe was not available inside EveOS.');
    await frame.waitForFunction(
      () => document.readyState === 'complete' || document.readyState === 'interactive',
      null,
      { timeout:30000 }
    );
    await frame.evaluate(() => globalThis.showFindMedia?.());
    await frame.locator('#sourceInput').fill(target);
    await frame.locator('#loadBtn').click();

    try {
      await frame.waitForFunction(() => {
        const video=document.querySelector('#mediaVideo');
        return !!video && video.readyState>=1;
      }, null, { timeout:60000 });
    } catch (error) {
      const loadState = await frame.evaluate(() => {
        const video=document.querySelector('#mediaVideo');
        return {
          sourceKind: globalThis.state?.source?.kind || null,
          source: globalThis.state?.source || null,
          mediaDiagnostics: globalThis.watchFusionMediaDiagnostics?.snapshot?.() || null,
          video: video ? {
            readyState:video.readyState,
            networkState:video.networkState,
            paused:video.paused,
            ended:video.ended,
            currentTime:Number(video.currentTime)||0,
            duration:Number.isFinite(video.duration)?video.duration:null,
            currentSrc:video.currentSrc||video.src||'',
            error:video.error ? { code:video.error.code, message:video.error.message || '' } : null
          } : null
        };
      });
      throw new Error(`WatchFusion media did not become video-ready within 60s. LOAD_STATE=${JSON.stringify(loadState)}`);
    }

    const layoutStart = {
      outer: await outerLayoutSnapshot(page),
      inner: await innerLayoutSnapshot(frame)
    };

    await page.evaluate(() => {
      const diag={ raf:[], last:0, longTasks:[] };
      window.__wfOuterPresentDiag=diag;
      const tick=now=>{
        if(diag.last)diag.raf.push(now-diag.last);
        diag.last=now;
        diag.rafId=requestAnimationFrame(tick);
      };
      diag.rafId=requestAnimationFrame(tick);
      try{
        diag.observer=new PerformanceObserver(list=>{
          for(const entry of list.getEntries())diag.longTasks.push({start:entry.startTime,duration:entry.duration});
        });
        diag.observer.observe({type:'longtask',buffered:true});
      }catch{}
    });

    await frame.evaluate(() => {
      const video=document.querySelector('#mediaVideo');
      const diag={ frames:[], lastFrame:0, events:[], samples:[], longTasks:[] };
      window.__wfInnerPresentDiag=diag;
      for(const name of ['loadedmetadata','durationchange','waiting','stalled','playing','canplay','seeking','seeked','ended','error']){
        video.addEventListener(name,()=>diag.events.push({name,at:performance.now(),time:Number(video.currentTime)||0}),{passive:true});
      }
      if(typeof video.requestVideoFrameCallback==='function'){
        const frameTick=now=>{
          if(diag.lastFrame)diag.frames.push(now-diag.lastFrame);
          diag.lastFrame=now;
          video.requestVideoFrameCallback(frameTick);
        };
        video.requestVideoFrameCallback(frameTick);
      }
      try{
        diag.observer=new PerformanceObserver(list=>{
          for(const entry of list.getEntries())diag.longTasks.push({start:entry.startTime,duration:entry.duration});
        });
        diag.observer.observe({type:'longtask',buffered:true});
      }catch{}
      video.play?.().catch(()=>{});
      diag.timer=setInterval(()=>{
        const snap=globalThis.watchFusionMediaDiagnostics?.snapshot?.()||{};
        diag.samples.push({at:performance.now(),...snap});
      },250);
    });

    if (untilEnded) {
      await Promise.race([
        frame.waitForFunction(() => document.querySelector('#mediaVideo')?.ended === true, null, { timeout:maxSeconds*1000 }).catch(() => null),
        page.waitForTimeout(maxSeconds*1000)
      ]);
      await page.waitForTimeout(350);
    } else {
      await page.waitForTimeout(seconds*1000);
    }

    const layoutEnd = {
      outer: await outerLayoutSnapshot(page),
      inner: await innerLayoutSnapshot(frame)
    };

    const outer=await page.evaluate(() => {
      const diag=window.__wfOuterPresentDiag||{raf:[],longTasks:[]};
      cancelAnimationFrame(diag.rafId);
      diag.observer?.disconnect?.();
      return { raf:diag.raf, longTasks:diag.longTasks };
    });
    const inner=await frame.evaluate(() => {
      const diag=window.__wfInnerPresentDiag;
      clearInterval(diag.timer);
      diag.observer?.disconnect?.();
      const first=diag.samples[0]||{},last=diag.samples.at(-1)||{};
      return {
        frames:diag.frames,
        events:diag.events,
        longTasks:diag.longTasks,
        samples:diag.samples,
        elapsedPlaybackSec:Math.max(0,(Number(last.currentTime)||0)-(Number(first.currentTime)||0)),
        start:first,end:last
      };
    });

    const outerRaf=summarizeIntervals(outer.raf);
    const innerFrames=summarizeIntervals(inner.frames);
    const waiting=inner.events.filter(event=>event.name==='waiting'||event.name==='stalled');
    const droppedRatio=inner.end.totalFrames?Number(inner.end.droppedFrames||0)/Number(inner.end.totalFrames):0;
    const outerLongMs=outer.longTasks.reduce((sum,item)=>sum+Number(item.duration||0),0);
    const innerLongMs=inner.longTasks.reduce((sum,item)=>sum+Number(item.duration||0),0);
    const expectedWindow = untilEnded ? Math.min(seconds, 20) : seconds;
    const healthyPlayback=inner.elapsedPlaybackSec>=expectedWindow*.65 && waiting.length<=2;
    const healthyPresentation=outerRaf.over100Ms<=2 && innerFrames.over100Ms<=2 && droppedRatio<.08;
    const health=healthyPlayback&&healthyPresentation?'good':'degraded';

    return {
      smoke:'watchfusion-eveos-video-present',
      mode:headed?'headed':'headless',
      eveosUrl,target,seconds,untilEnded,maxSeconds,headed,channel:channel||null,health,
      playback:{
        elapsedPlaybackSec:inner.elapsedPlaybackSec,
        waitingOrStalledEvents:waiting,
        eventCounts:inner.events.reduce((out,event)=>{out[event.name]=(out[event.name]||0)+1;return out;},{}),
        droppedFrameRatio:droppedRatio,
        start:inner.start,end:inner.end
      },
      presentation:{
        outerRaf,
        innerVideoFrames:innerFrames,
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
    if (browser) await browser.close().catch(() => {});
  }
}

(async () => {
  const results=[];
  for (const headed of runModes) {
    const mode=headed?'headed':'headless';
    console.log(`WATCHFUSION_EVEOS_VIDEO_PRESENT_START ${mode}`);
    try {
      const result=await runPass(headed);
      results.push(result);
      console.log(JSON.stringify(result,null,2));
      console.log(`WATCHFUSION_EVEOS_VIDEO_PRESENT_${mode.toUpperCase()}_${result.health==='good'?'OK':'DEGRADED'}`);
    } catch (error) {
      const failed={ smoke:'watchfusion-eveos-video-present', mode, health:'error', error:error.stack||String(error) };
      results.push(failed);
      console.error(JSON.stringify(failed,null,2));
    }
  }

  const overall=results.every(result=>result.health==='good')?'good':'degraded';
  if (runModes.length>1) {
    console.log(JSON.stringify({
      smoke:'watchfusion-eveos-video-present-matrix',
      target,seconds,untilEnded,maxSeconds,channel:channel||null,
      health:overall,
      modes:results.map(result=>({
        mode:result.mode,
        health:result.health,
        elapsedPlaybackSec:result.playback?.elapsedPlaybackSec ?? null,
        outerWorstRafMs:result.presentation?.outerRaf?.worstMs ?? null,
        innerWorstFrameMs:result.presentation?.innerVideoFrames?.worstMs ?? null,
        droppedFrameRatio:result.playback?.droppedFrameRatio ?? null,
        error:result.error || null
      }))
    },null,2));
    console.log(`WATCHFUSION_EVEOS_VIDEO_PRESENT_MATRIX_${overall==='good'?'OK':'DEGRADED'}`);
  }
  if(strict&&overall!=='good')process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
