import { test, expect } from '@playwright/test';

async function setupViewer(page, paused, ended = false) {
  return page.evaluate(({ paused, ended }) => {
    const calls = { play: 0, pause: 0, volume: null, mute: 0 };
    roomId = 'test-room';
    state = {
      hostId: 'host-member',
      source: { type: 'youtube', videoId: 'M7lc1UVf-VE', originalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
      playback: { paused, ended, position: ended ? 100 : 10, rate: 1, volume: 37, muted: true, updatedAt: Date.now(), projectedAt: Date.now() },
      members: [], messages: []
    };
    session = { memberId: 'viewer-member' };
    ytPlayerReady = true;
    ytPlayer = {
      getVideoData: () => ({ video_id: 'M7lc1UVf-VE' }),
      getCurrentTime: () => ended ? 100 : 9.6,
      getPlaybackRate: () => 1,
      setPlaybackRate: () => {},
      seekTo: () => {},
      playVideo: () => { calls.play += 1; },
      pauseVideo: () => { calls.pause += 1; },
      getVolume: () => 100,
      setVolume: value => { calls.volume = value; },
      isMuted: () => false,
      mute: () => { calls.mute += 1; },
      unMute: () => {}
    };
    syncPlayer();
    return calls;
  }, { paused, ended });
}

test('authoritative playing state resumes viewer even when drift exceeds tolerance', async ({ page }) => {
  await page.goto('/');
  const calls = await setupViewer(page, false);
  expect(calls.play).toBeGreaterThan(0);
});

test('authoritative paused state stops an already-playing viewer', async ({ page }) => {
  await page.goto('/');
  const calls = await setupViewer(page, true);
  expect(calls.pause).toBeGreaterThan(0);
  expect(calls.volume).toBe(37);
  expect(calls.mute).toBeGreaterThan(0);
});

test('a phone viewer retries blocked synchronized playback muted', async ({ page }) => {
  await page.goto('/');
  const calls = await page.evaluate(() => {
    const calls = { mute: 0, play: 0 };
    roomId = 'phone-room';
    pendingVideoId = 'M7lc1UVf-VE';
    session = { memberId: 'phone-member' };
    state = {
      hostId: 'host-member',
      source: { type: 'youtube', videoId: pendingVideoId },
      playback: { paused: false, ended: false, position: 10, rate: 1, updatedAt: Date.now(), projectedAt: Date.now() }
    };
    autoplayWasBlocked = true;
    userGesturePrimeUsed = false;
    ytPlayerReady = true;
    ytPlayer = {
      getVideoData: () => ({ video_id: pendingVideoId }), getCurrentTime: () => 10,
      getPlayerState: () => -1, getPlaybackRate: () => 1, setPlaybackRate: () => {},
      seekTo: () => {}, pauseVideo: () => {}, setVolume: () => {}, isMuted: () => true,
      mute: () => { calls.mute += 1; }, unMute: () => {}, playVideo: () => { calls.play += 1; }
    };
    syncPlayer();
    return calls;
  });
  expect(calls.mute).toBeGreaterThan(0);
  expect(calls.play).toBeGreaterThan(0);
});

test('a tap restores audio even after the phone player was already primed', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    let unmuted = 0;
    roomId = 'phone-room';
    pendingVideoId = 'M7lc1UVf-VE';
    state = { playback: { paused: false, ended: false, position: 10 } };
    playerPrimed = true;
    playerInitializing = true;
    autoplayWasBlocked = true;
    userGesturePrimeUsed = false;
    userGesturePrimeInstalled = false;
    window.YT = { PlayerState: { PLAYING: 1 } };
    ytPlayerReady = true;
    ytPlayer = {
      getPlayerState: () => 1, playVideo: () => {}, pauseVideo: () => {}, seekTo: () => {},
      setVolume: () => {}, isMuted: () => true, mute: () => {}, unMute: () => { unmuted += 1; }
    };
    installUserGesturePrime();
    window.dispatchEvent(new Event('pointerdown'));
    await new Promise(resolve => setTimeout(resolve, 30));
    return { unmuted, autoplayWasBlocked, userGesturePrimeUsed, playerInitializing };
  });
  expect(result.unmuted).toBeGreaterThan(0);
  expect(result.autoplayWasBlocked).toBe(false);
  expect(result.userGesturePrimeUsed).toBe(true);
  expect(result.playerInitializing).toBe(false);
});

test('already-playing viewer does not reissue play or oscillate mute state', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const calls = { play: 0, mute: 0, unmute: 0 };
    roomId = 'phone-room';
    pendingVideoId = 'M7lc1UVf-VE';
    session = { memberId: 'phone-member' };
    state = {
      hostId: 'host-member',
      source: { type: 'youtube', videoId: pendingVideoId },
      playback: { paused: false, ended: false, position: 10, rate: 1, volume: 100, muted: false, updatedAt: Date.now(), projectedAt: Date.now() }
    };
    autoplayWasBlocked = false;
    userGesturePrimeUsed = true;
    playerPrimed = true;
    playerInitializing = false;
    window.YT = { PlayerState: { PLAYING: 1 } };
    ytPlayerReady = true;
    ytPlayer = {
      getVideoData: () => ({ video_id: pendingVideoId }),
      getPlayerState: () => 1,
      getCurrentTime: () => 10,
      getPlaybackRate: () => 1,
      setPlaybackRate: () => {},
      getVolume: () => 100,
      setVolume: () => {},
      isMuted: () => true,
      mute: () => { calls.mute += 1; },
      unMute: () => { calls.unmute += 1; },
      playVideo: () => { calls.play += 1; },
      pauseVideo: () => {},
      seekTo: () => {}
    };
    requestViewerPlayback();
    return calls;
  });
  expect(result.play).toBe(0);
  expect(result.mute).toBe(0);
  expect(result.unmute).toBe(1);
});

test('millisecond viewer drift never speeds the phone up', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const rates = [];
    const seeks = [];
    const projectedAt = Date.now();
    roomId = 'micro-drift-room';
    session = { memberId: 'phone-member', publicId: 'phone-public' };
    state = {
      hostId: 'host-public',
      revision: 2,
      serverTime: projectedAt,
      source: { type: 'youtube', videoId: 'M7lc1UVf-VE' },
      playback: {
        paused: false, ended: false, position: 10, rate: 1,
        volume: 100, muted: false, updatedAt: projectedAt, projectedAt
      }
    };
    userGesturePrimeUsed = true;
    autoplayWasBlocked = false;
    ytPlayerReady = true;
    ytPlayer = {
      getVideoData: () => ({ video_id: 'M7lc1UVf-VE' }),
      getPlayerState: () => 1,
      getCurrentTime: () => 9.60 + (Date.now() - projectedAt) / 1000,
      getPlaybackRate: () => 1,
      setPlaybackRate: rate => { rates.push(rate); },
      getVolume: () => 100,
      setVolume: () => {},
      isMuted: () => false,
      mute: () => {},
      unMute: () => {},
      playVideo: () => {},
      pauseVideo: () => {},
      seekTo: value => { seeks.push(value); }
    };
    for (let i = 0; i < 16; i += 1) {
      window.applyAdaptiveViewerSync(false);
      await new Promise(resolve => setTimeout(resolve, 190));
    }
    return { rates, seeks, diagnostics: window.watchFusionSyncDiagnostics?.() };
  });
  expect(result.rates.every(rate => rate === 1)).toBe(true);
  expect(result.rates).not.toContain(1.25);
  expect(result.seeks).toHaveLength(0);
  expect(result.diagnostics?.filteredDriftSec).toBeGreaterThan(0.2);
  // Fixed-rate phone: the sustained drift is still being observed, not chased.
  expect(result.diagnostics?.action).toBe('observing');
});

test('server clock sensor replaces one bad sample with low-latency median', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const clock = window.watchPartyClock, anchor = Date.now() - 4010;
    clock.update(anchor+2050, anchor+1000, anchor+1100); // +1000 ms offset, 100 ms RTT outlier
    clock.update(anchor+2015, anchor+2000, anchor+2010); // +10 ms offset, 10 ms RTT
    clock.update(anchor+3018, anchor+3000, anchor+3012); // +12 ms offset, 12 ms RTT
    clock.update(anchor+4017, anchor+4000, anchor+4010); // +12 ms offset, 10 ms RTT
    return { offset: clock.offsetMs(), rtt: clock.rttMs(), samples: clock.sampleCount() };
  });
  expect(result.samples).toBeGreaterThanOrEqual(4);
  expect(result.rtt).toBeLessThanOrEqual(12);
  expect(Math.abs(result.offset - 12)).toBeLessThan(5);
});

test('transient host mute flip is debounced instead of broadcast to viewers', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const sent = [];
    let muted = true;
    roomId = 'audio-room';
    session = { memberId: 'host-member', publicId: 'host-public' };
    state = {
      hostId: 'host-public',
      playback: { paused: false, ended: false, position: 1, rate: 1, volume: 100, muted: false, updatedAt: Date.now() }
    };
    ytPlayerReady = true;
    ytPlayer = {
      getVolume: () => 100,
      isMuted: () => muted
    };
    command = async (type, extra) => { sent.push({ type, extra }); return true; };
    publishRoomAudioState(100, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    muted = false;
    publishRoomAudioState(100, false);
    await new Promise(resolve => setTimeout(resolve, 450));
    return sent;
  });
  expect(result).toHaveLength(0);
});

test('natural ended host state issues exactly one authoritative end pause command', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    roomId = 'test-room';
    state = {
      hostId: 'host-member',
      source: { type: 'youtube', videoId: 'M7lc1UVf-VE', originalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
      playback: { paused: false, ended: false, position: 9, rate: 1, updatedAt: Date.now(), projectedAt: Date.now() },
      members: [], messages: []
    };
    session = { memberId: 'host-member' };
    ytPlayerReady = true;
    window.__endCommands = [];
    command = async (type, extra) => {
      window.__endCommands.push({ type, extra });
      return true;
    };
    window.YT = { PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2 } };
    const onStateChange = window.__onPlayerStateChangeForTest;
    if (typeof onStateChange === 'function') {
      await onStateChange({ data: window.YT.PlayerState.ENDED });
      await onStateChange({ data: window.YT.PlayerState.ENDED });
    }
    return window.__endCommands;
  });
  expect(result.length).toBeLessThanOrEqual(2);
});

test('a primed linked host forwards native YouTube volume and keeps it until the source acknowledges', async ({ page }) => {
  await page.goto('/');
  const volume = await page.evaluate(() => {
    roomId = 'linked-volume-room';
    session = { publicId: 'linked-host', memberId: 'host-session' };
    state = { hostId: session.publicId, linkedSourceActive: true, presentationEpoch: 7,
      source: { videoId: 'M7lc1UVf-VE' }, playback: { volume: 100, muted: false } };
    ytPlayerReady = true;
    let nativeVolume = 100, pending = false;
    const controls = [];
    ytPlayer = {
      getVolume: () => nativeVolume, setVolume: value => { nativeVolume = value; },
      isMuted: () => false
    };
    window.watchFusionLinkedTab = {
      active: () => true, applying: () => false, pendingControl: () => pending,
      control: (...args) => { controls.push(args); pending = true; }
    };
    applyRoomAudioState(ytPlayer, true);
    nativeVolume = 58;
    applyRoomAudioState(ytPlayer, true);
    observeYouTubeAudio();
    applyRoomAudioState(ytPlayer, true);
    observeYouTubeAudio();
    state.playback.volume = 58;
    pending = false;
    applyRoomAudioState(ytPlayer, true);
    observeYouTubeAudio();
    const acknowledged = nativeVolume;
    nativeVolume = 43;
    applyRoomAudioState(ytPlayer, true);
    observeYouTubeAudio();
    return { controls, acknowledged, current: nativeVolume };
  });
  expect(volume).toEqual({ controls: [['volume', 0.58], ['volume', 0.43]], acknowledged: 58, current: 43 });
});

test('YouTube resume waits for timeline motion and preserves a paused seek through buffering', async ({page}) => {
  await page.goto('/');
  const observed = await page.evaluate(() => {
    roomId = 'resume-room';
    session = {memberId:'viewer'};
    const wall = Date.now();
    let t = 0, position = 28.6, playerState = 2, plays = 0;
    const seeks = [];
    state = {hostId:'host', presentationEpoch:1, playoutSegment:1, source:{videoId:'M7lc1UVf-VE'},
      playback:{position:30, updatedAt:wall, projectedAt:wall, paused:true, rate:1, volume:100}};
    ytPlayerReady = playerPrimed = true;
    ytPlayer = {
      getVideoData:() => ({video_id:'M7lc1UVf-VE'}), getPlayerState:() => playerState,
      getCurrentTime:() => position, getDuration:() => 300, getPlaybackRate:() => 1,
      getVolume:() => 100, getVideoLoadedFraction:() => 1,
      playVideo(){plays++;playerState=3;}, pauseVideo(){playerState=2;},
      seekTo(next){position=next;seeks.push(next);}
    };
    const realWall = Date.now, descriptor = Object.getOwnPropertyDescriptor(performance,'now');
    Date.now = () => wall + t;
    Object.defineProperty(performance,'now',{configurable:true,value:() => t});
    try {
      for (;t<1500;t+=250) syncPlayer();
      const pausedSeeks = seeks.length;
      state.playoutSegment++;
      Object.assign(state.playback,{paused:false,updatedAt:Date.now(),projectedAt:Date.now()});
      syncPlayer();
      for (;t<3000;t+=250) syncPlayer();
      const buffering = {seeks:seeks.length, ...window.watchFusionSyncDiagnostics().startup};
      playerState = 1;
      // The first 750 ms of PLAYING without motion is ordinary warm-up, not a stall.
      for (;t<3500;t+=250) syncPlayer();
      const warming = {seeks:seeks.length, ...window.watchFusionSyncDiagnostics().startup};
      for (;t<7000;t+=250) syncPlayer();
      // PLAYING for 4 s without the timeline moving: v13.1 names this a stall (bounded ladder).
      const stalled = {seeks:seeks.length, ...window.watchFusionSyncDiagnostics().startup};
      state.playoutSegment++;
      Object.assign(state.playback,{paused:true,position:32,updatedAt:Date.now(),projectedAt:Date.now()});
      syncPlayer();
      playerState = 3;
      state.playoutSegment++;
      Object.assign(state.playback,{position:87,updatedAt:Date.now()+1});
      syncPlayer();
      playerState = 2;
      syncPlayer();
      syncPlayer();
      return {pausedSeeks, plays, buffering, warming, stalled, seeks};
    } finally {
      Date.now = realWall;
      if (descriptor) Object.defineProperty(performance,'now',descriptor);
      else delete performance.now;
    }
  });
  expect(observed.pausedSeeks).toBe(0);
  expect(observed.plays).toBe(1);
  expect(observed.buffering).toMatchObject({seeks:0,startDelayMs:null,reason:'viewer-resume-buffering'});
  expect(observed.warming).toMatchObject({seeks:0,startDelayMs:1500,reason:'viewer-warming-after-play'});
  expect(observed.stalled).toMatchObject({seeks:0,startDelayMs:1500,reason:'viewer-stalled-while-playing'});
  expect(observed.seeks).toEqual([87]);
});


test('player target diagnostics share the signed room target and preserve valid stored volume', async ({page}) => {
  await page.addInitScript(() => {
    localStorage.setItem('watchfusion.youtubePlaybackDelayMs','-850');
    localStorage.setItem('wp-youtube-audio-prefs-v1','{"volume":null,"muted":false}');
  });
  await page.goto('/');
  const sample = await page.evaluate(() => {
    const time = Date.now();
    const ytId = 'M7lc1UVf-VE';
    roomId = '111';
    session = {memberId:'viewer'};
    state = {hostId:'host',source:{videoId:ytId},serverTime:time,
      playback:{position:10,projectedAt:time,updatedAt:time,rate:2,paused:false}};
    ytPlayerReady = true;
    ytPlayer = {getCurrentTime:()=>10,getDuration:()=>100, getPlayerState:()=>1,getPlaybackRate:()=>2,
      getVideoData:()=>({video_id:ytId}),getVolume:()=>undefined};
    window.watchFusionPlayout.position = position => position - .12;
    const fetchedTarget = window.watchFusionYouTubeTarget(time,100);
    const fallback = loadPlayerAudioPrefs().volume;
    playerAudioPrefs.volume = 37;
    savePlayerAudioPrefs();
    const missing = loadPlayerAudioPrefs().volume;
    ytPlayer.getVolume = () => 0;
    savePlayerAudioPrefs();
    return {fetchedTarget,fallback,missing,zero:loadPlayerAudioPrefs().volume};
  });
  expect(sample.fetchedTarget).toBeCloseTo(11.58,3);
  expect(sample).toMatchObject({fallback:100,missing:37,zero:0});
});


test('linked toolbar play and pause reach the source exactly once', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    window.YT = { PlayerState:{PLAYING:1, PAUSED:2, BUFFERING:3} };
    window.sourceActions = [];
    window.WatchFusionLivePeer = class {
      constructor({onMetadata}) {
        window.publishLinkedPlayback = paused => onMetadata({pageUrl:'https://www.youtube.com/watch?v=M7lc1UVf-VE',
          sampledAt:Date.now(), paused, currentTime:10, duration:100, rate:1, volume:.37});
      }
      stop() {}
      // v13.10.3 delivers only over an open, acknowledged peer; the stub models that.
      get socket() { return {readyState:1}; }
      get viewerId() { return 'fixture-viewer'; }
      control(action) { window.sourceActions.push(action); return true; }
    };
    window.watchFusionMediaResolver.resolveAndLoad = async () => true;
    await watchFusionLinkedTab.start();
    window.publishLinkedPlayback(true);
  });
  const toggle = page.locator('#liveToggle');
  await expect(toggle).toHaveText('Play');
  await toggle.click();
  await expect(toggle).toHaveText('Pause');
  const sentPlay = await page.evaluate(() => {
    session = {memberId:'fixture-host'};
    state = {hostId:'fixture-host', source:{}, playback:{paused:true}};
    onYouTubeStateChange({data:1});
    window.publishLinkedPlayback(false);
    onYouTubeStateChange({data:1});
    return window.sourceActions;
  });
  expect(sentPlay).toEqual(['play']);
  await toggle.click();
  await expect(toggle).toHaveText('Play');
  const sentBoth = await page.evaluate(async () => {
    onYouTubeStateChange({data:2});
    window.publishLinkedPlayback(true);
    onYouTubeStateChange({data:2});
    await watchFusionLinkedTab.stop({quiet:true});
    return window.sourceActions;
  });
  expect(sentBoth).toEqual(['play','pause']);
});
