import { test, expect } from '@playwright/test';

function configureViewer(page, { current, target = 100, paused = false, rate = 1, samples = 1, currentRate = 1,
  advancing = false, resumed = false, resumeFrom = target, lagPerTick = 0, advanceAfterSeek = false }) {
  return page.evaluate(({ current, target, paused, rate, samples, currentRate, advancing, resumed, resumeFrom, lagPerTick, advanceAfterSeek }) => {
    const calls = { seek: [], rates: [], play: 0, pause: 0 };
    roomId = 'drift-room';
    state = {
      hostId: 'host-member',
      presentationEpoch: 1, playoutSegment: 12,
      source: { type: 'youtube', videoId: 'M7lc1UVf-VE', originalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
      playback: {
        paused,
        position: target,
        rate,
        updatedAt: Date.now(),
        projectedAt: Date.now()
      },
      members: [], messages: []
    };
    session = { memberId: 'viewer-member' };
    ytPlayerReady = true;
    ytPlayer = {
      getPlayerState: () => paused && resumed ? 2 : 1,
      getVideoData: () => ({ video_id: 'M7lc1UVf-VE' }),
      getCurrentTime: () => current,
      getDuration: () => 300,
      getVideoLoadedFraction: () => 1,
      getPlaybackRate: () => currentRate,
      setPlaybackRate: value => { calls.rates.push(value); currentRate = value; },
      seekTo: value => { calls.seek.push(value); current = value; },
      playVideo: () => { calls.play += 1; },
      pauseVideo: () => { calls.pause += 1; },
      setVolume: () => {},
      isMuted: () => false,
      mute: () => {},
      unMute: () => {}
    };
    if (resumed) {
      const firstPlayingPosition = current;
      state.playback = {...state.playback, paused:true, position:resumeFrom};
      current = resumeFrom;
      paused = true;
      syncPlayer();
      current = firstPlayingPosition;
      paused = false;
      state.playoutSegment++;
      state.playback = {...state.playback, paused:false, position:target, projectedAt:Date.now(),
        updatedAt:state.playback.updatedAt + 1};
      calls.seek.length = 0;
    }
    const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    const began = performance.now(), wall = Date.now(), realDateNow = Date.now;
    try {
      for (let index = 0; index < samples; index++) {
        // Wall and monotonic clocks advance together, as they do on a real device.
        Object.defineProperty(performance, 'now', { configurable: true, value: () => began + index * 250 });
        Date.now = () => wall + index * 250;
        // Without advanceAfterSeek the fake decoder freezes after its first seek (stall-ladder case).
        if (advancing && index > 0 && (advanceAfterSeek || !calls.seek.length)) {
          current += .25 * rate - (index > 9 && index < 28 ? lagPerTick : 0);
          state.playback.position += .25 * rate;
          state.playback.updatedAt++;
          state.playback.projectedAt = Date.now();
        }
        syncPlayer();
      }
    } finally {
      Date.now = realDateNow;
      if (descriptor) Object.defineProperty(performance, 'now', descriptor);
      else delete performance.now;
    }
    calls.status = document.querySelector('#syncStatus').textContent;
    calls.diagnostics = window.watchFusionSyncDiagnostics();
    return calls;
  }, { current, target, paused, rate, samples, currentRate, advancing, resumed, resumeFrom, lagPerTick, advanceAfterSeek });
}

test.describe('Adaptive playback drift regression', () => {
  test('linked playback projects fresh running samples instead of chasing stale timestamps', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      const now = Date.now();
      const sync = window.WatchFusionLinkedPlaybackSync;
      return {
        projected: sync.projectedPosition({ currentTime: 20, paused: false, sampledAt: now - 750, rate: 1 }, now),
        paused: sync.projectedPosition({ currentTime: 20, paused: true, sampledAt: now - 750, rate: 1 }, now),
        stale: sync.projectedPosition({ currentTime: 20, paused: false, sampledAt: now - 4000, rate: 1 }, now)
      };
    });
    expect(result.projected).toBeGreaterThan(20.70);
    expect(result.projected).toBeLessThan(20.80);
    expect(result.paused).toBe(20);
    expect(result.stale).toBe(20);
  });

  test('steady linked playback does not republish equivalent room anchors', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      const sync = window.WatchFusionLinkedPlaybackSync;
      const now = Date.now();
      const anchor = {
        position: 10,
        sampledAt: now,
        paused: false,
        ended: false,
        rate: 1,
        volume: 0.5
      };
      return {
        steady: sync.mirrorPlan({ currentTime: 11.5, sampledAt: now + 1500, paused: false, rate: 1, volume: 0.5 }, anchor, { now: now + 1500 }),
        jitter: sync.mirrorPlan({ currentTime: 11.8, sampledAt: now + 1500, paused: false, rate: 1, volume: 0.5 }, anchor, { now: now + 1500 }),
        longSteady: sync.mirrorPlan({ currentTime: 15, sampledAt: now + 5000, paused: false, rate: 1, volume: 0.5 }, anchor, { now: now + 5000 }),
        delayed: sync.mirrorPlan({ currentTime: 11, sampledAt: now + 1000, paused: false, rate: 1, volume: 0.5 }, anchor, { now: now + 5000 }),
        seek: sync.mirrorPlan({ currentTime: 20, sampledAt: now + 1500, paused: false, rate: 1, volume: 0.5 }, anchor, { now: now + 1500 }),
        pause: sync.mirrorPlan({ currentTime: 11.5, sampledAt: now + 1500, paused: true, rate: 1, volume: 0.5 }, anchor, { now: now + 1500 })
      };
    });
    expect(result.steady.publish).toBe(false);
    expect(result.jitter.publish).toBe(false);
    expect(result.longSteady.publish).toBe(false);
    expect(result.delayed.reason).toBe('stale');
    expect(result.seek.publish).toBe(true);
    expect(result.seek.reason).toBe('drift');
    expect(result.pause.publish).toBe(true);
    expect(result.pause.reason).toBe('state');
  });

  test('linked direct-media follower tolerates small drift without rearming its control guard', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      let current = 10, rate = 1, volume = 0.5, paused = false;
      mediaPlayerReady = true;
      mediaAttachedGuardUntil = 0;
      mediaVideo = {
        readyState: 4,
        get currentTime(){ return current; }, set currentTime(value){ current = value; },
        get playbackRate(){ return rate; }, set playbackRate(value){ rate = value; },
        get volume(){ return volume; }, set volume(value){ volume = value; },
        get paused(){ return paused; },
        play(){ paused = false; return Promise.resolve(); },
        pause(){ paused = true; }
      };
      const now = Date.now();
      const steady = followAttachedMedia({ currentTime: 9.7, sampledAt: now - 300, paused: false, rate: 1, volume: 0.5 }, { now });
      const guardAfterSteady = mediaAttachedGuardUntil;
      const jumped = followAttachedMedia({ currentTime: 15, sampledAt: now, paused: false, rate: 1, volume: 0.5 }, { now });
      return { steady, jumped, guardAfterSteady, guardAfterJump: mediaAttachedGuardUntil, current };
    });
    expect(result.steady).toBe(true);
    expect(result.guardAfterSteady).toBe(0);
    expect(result.jumped).toBe(true);
    expect(result.guardAfterJump).toBeGreaterThan(0);
    expect(result.current).toBe(15);
  });

  test('one moderate drift sample never changes speed or seeks', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 99, target: 100 });

    expect(calls.seek).toEqual([]);
    expect(calls.rates).toEqual([]);
    expect(calls.diagnostics.stable).toBe(false);
    expect(calls.diagnostics.sampleCount).toBe(1);
  });

  test('small viewer drift does not introduce an aggressive correction', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 99.97, target: 100, samples: 14, advancing: true });

    expect(calls.seek).toEqual([]);
    expect(calls.rates).not.toContain(1.25);
    expect(calls.diagnostics.stable).toBe(true);
    expect(['observing', 'locked']).toContain(calls.diagnostics.action);
  });

  test('stable fractional sensor drift preserves the host rate without seeking', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 99.82, target: 100, samples: 14, advancing: true });

    expect(calls.seek).toEqual([]);
    expect(calls.rates).toEqual([]);
    expect(calls.diagnostics.stable).toBe(true);
    expect(calls.diagnostics.filteredDriftSec).toBeGreaterThan(0.15);
    expect(['observing', 'locked']).toContain(calls.diagnostics.action);
  });

  // v13 policy: a steady 600 ms error is a real error (the target is <=200 ms), so it
  // is corrected by a landing-aware rejoin. This fixture freezes after any seek, so
  // every attempt fails: the arbiter must back off and suspend, never loop.
  test('a steady 600 ms post-resume phase is corrected with bounded attempts', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 99.4, target: 100, samples: 90, advancing: true, resumed: true });
    expect(calls.seek.length).toBeGreaterThanOrEqual(1);
    expect(calls.seek.length).toBeLessThanOrEqual(3);
    expect(calls.rates).toEqual([]);
    expect(calls.diagnostics.arbiter.rejoins).toBe(calls.seek.length);
  });

  test('persistent lag growth can trigger one guarded correction after resume', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, {current:99.55, advancing:true, resumed:true, samples:90, lagPerTick:.03,
      advanceAfterSeek:true});
    expect(calls.seek).toHaveLength(1);
    expect(calls.diagnostics.arbiter.rejoins).toBe(1);
    expect(calls.diagnostics.arbiter.stallSteps).toBe(0);
  });

  test('a decoder that freezes after its lag correction gets the bounded stall ladder, not a seek loop', async ({ page }) => {
    await page.goto('/');
    // 140 samples outlast the ladder on v13.5-v13.7; 300 samples show the same three seeks.
    const calls = await configureViewer(page, {current:99.55, advancing:true, resumed:true, samples:140, lagPerTick:.03});
    expect(calls.seek).toHaveLength(3);
    expect(calls.seek[1]).toBeGreaterThan(calls.seek[0] + 5);
    expect(calls.diagnostics.arbiter.stallSteps).toBe(3);
    expect(calls.diagnostics.arbiter.rejoins).toBe(3);
    expect(calls.diagnostics.arbiter.reason).toBe('stall-recovery-exhausted');
  });

  for (const succeeds of [true, false]) {
    test(`a 1190 ms fixed-rate TV gets one buffered attempt and ${succeeds ? 'converges' : 'backs off'}`, async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(succeeds => {
        const wall = Date.now();
        let t = 0, drift = 1.19, bufferingUntil = 0, reloads = 0;
        const seeks = [];
        const realDateNow = Date.now;
        const realPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now');
        Date.now = () => wall + t;
        Object.defineProperty(performance, 'now', {configurable:true, value:() => t});
        try {
          roomId = 'residual-room';
          session = {memberId:'tv'};
          state = {hostId:'host', presentationEpoch:1, playoutSegment:1,
            source:{videoId:'M7lc1UVf-VE'},
            playback:{paused:false, position:30, updatedAt:wall, projectedAt:wall, rate:1, volume:100}};
          ytPlayerReady = playerPrimed = true;
          ytPlayer = {
            getPlayerState: () => t < bufferingUntil ? 3 : 1,
            getVideoData: () => ({video_id:'M7lc1UVf-VE'}),
            getCurrentTime: () => 30 + t / 1000 - drift,
            getDuration: () => 300, getVolume: () => 100, getPlaybackRate: () => 1,
            getVideoLoadedFraction: () => 1, playVideo(){},
            loadVideoById(){reloads++;},
            seekTo(position, network) {
              const lead = position - (30 + t / 1000);
              seeks.push({t,lead,network});
              if (succeeds) drift = .08; // landed inside the v13.10.5 100 ms action edge
              bufferingUntil = t + 500;
            }
          };
          for (t = 0; t <= 120000; t += 250) syncPlayer();
          return {seeks, reloads, drift, health:window.watchFusionSyncDiagnostics().arbiter};
        } finally {
          Date.now = realDateNow;
          if (realPerformanceNow) Object.defineProperty(performance, 'now', realPerformanceNow);
          else delete performance.now;
        }
      }, succeeds);
      expect(result.reloads).toBe(0);
      // Never on the first samples: the error must be observed over a stable window.
      expect(result.seeks[0].t).toBeGreaterThanOrEqual(1400);
      // A rejoin seeks AHEAD of the room within the buffer and releases on schedule.
      expect(result.seeks.every(seek => seek.lead > 0 && seek.network === false)).toBe(true);
      if (succeeds) {
        expect(result.seeks).toHaveLength(1);
        expect(result.drift).toBeLessThan(.20);
      } else {
        // Corrections that never land back off with growing gaps, then suspend.
        expect(result.seeks.length).toBeLessThanOrEqual(3);
        for (let i = 2; i < result.seeks.length; i++)
          expect(result.seeks[i].t - result.seeks[i-1].t).toBeGreaterThan(result.seeks[i-1].t - result.seeks[i-2].t);
        expect(result.health.phase).toBe('suspended');
        expect(result.drift).toBeCloseTo(1.19);
      }
    });
  }

  test('a large source jump from paused still forces room catch-up', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, {current:80, target:100, resumed:true, resumeFrom:80, samples:14, advancing:true});
    expect(calls.seek).toHaveLength(1);
    expect(calls.seek[0]).toBeGreaterThanOrEqual(100);
  });

  test('unsolicited room snapshots preserve measured server clock latency', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      const midpoint = Date.now() - 10;
      updateServerClock(midpoint, midpoint - 10, midpoint + 10);
      state = { revision: 1, source: {}, playback: {}, members: [], messages: [] };
      applyIncomingRoomState({
        revision: 2,
        serverTime: midpoint - 1000,
        source: {}, playback: {}, members: [], messages: []
      });
      return { rtt: window.watchPartyClock.rttMs(), offset: window.watchPartyClock.offsetMs() };
    });

    expect(result.rtt).toBe(20);
    expect(Math.abs(result.offset)).toBeLessThanOrEqual(1);
  });

  test('large viewer drift uses one corrective seek instead of a repeated seek loop', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 97, target: 100, samples: 14, advancing: true });

    expect(calls.seek).toHaveLength(1);
    expect(calls.seek[0]).toBeGreaterThanOrEqual(100);
  });

  // v13 policy: seeks that never land are bounded (backoff, then suspend) instead of
  // escalating into ever-larger blind seeks; recovery of keyframe-snapping players is
  // covered by the sync lab's landing models (SYNC-01, SYNC-11, SYNC-12).
  test('a TV whose seeks never land gets bounded attempts and no reloads', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      const wall = Date.now();
      let t = 0, landing = 0, bufferingUntil = 0, reloads = 0;
      const seeks = [];
      Date.now = () => wall + t;
      Object.defineProperty(performance, 'now', {configurable:true, value:() => t});
      roomId = 'recovery-room';
      session = {memberId:'tv'};
      state = {hostId:'host', presentationEpoch:1, playoutSegment:1,
        source:{videoId:'M7lc1UVf-VE'},
        playback:{paused:false, position:30, updatedAt:wall, projectedAt:wall, rate:1, volume:100}};
      ytPlayerReady = playerPrimed = true;
      ytPlayer = {
        getPlayerState: () => t < bufferingUntil ? 3 : 1,
        getVideoData: () => ({video_id:'M7lc1UVf-VE'}),
        getCurrentTime: () => 30 + t / 1000 - 2.3 + landing,
        getDuration: () => 300, getVolume: () => 100, getPlaybackRate: () => 1,
        getVideoLoadedFraction: () => 1, playVideo(){},
        loadVideoById(){reloads++;},
        seekTo(position) {
          const lead = position - (30 + t / 1000);
          seeks.push({t,lead});
          if (seeks.length === 3) landing = lead;
          bufferingUntil = t + 500;
        }
      };
      for (t = 0; t <= 110000; t += 250) syncPlayer();
      return {seeks, reloads, health:window.watchFusionSyncDiagnostics().arbiter};
    });
    expect(result.reloads).toBe(0);
    expect(result.seeks.length).toBeGreaterThanOrEqual(1);
    expect(result.seeks.length).toBeLessThanOrEqual(3);
    expect(result.seeks.every(seek => seek.lead > 0)).toBe(true);
    expect(result.health.failures).toBeGreaterThanOrEqual(1);
  });

  test('a buffering TV that is room host follows the linked timeline without repeated play or seek', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      const calls = { seek: 0, play: 0 };
      const now = Date.now();
      roomId = 'linked-room';
      session = { memberId: 'tv-session', publicId: 'tv-public' };
      state = { hostId: 'tv-public', linkedSourceActive: true,
        source: { videoId: 'M7lc1UVf-VE' },
        playback: { position: 100, paused: false, rate: 1, updatedAt: now, projectedAt: now } };
      ytPlayerReady = true;
      let current = 90;
      let playerState = 3;
      ytPlayer = {
        getVideoData: () => ({ video_id: 'M7lc1UVf-VE' }),
        getPlayerState: () => playerState,
        getCurrentTime: () => current,
        getPlaybackRate: () => 1,
        seekTo: value => { current = value; calls.seek++; },
        playVideo: () => { calls.play++; }
      };
      for (let tick = 0; tick < 20; tick++) syncPlayer();
      const buffering = { ...calls, action: window.watchFusionSyncDiagnostics().action };
      playerState = 1;
      const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
      const started = performance.now();
      try {
        for (let step = 0; step < 15; step++) {
          Object.defineProperty(performance, 'now', {configurable:true,value:() => started + step * 250});
          current += .25;
          state.playback.position += .25;
          state.playback.updatedAt++;
          state.playback.projectedAt = Date.now();
          syncPlayer();
        }
      } finally {
        if (descriptor) Object.defineProperty(performance, 'now', descriptor);
        else delete performance.now;
      }
      return { buffering, settled: calls };
    });
    expect(result.buffering).toEqual({ seek: 0, play: 0, action: 'buffering' });
    expect(result.settled).toEqual({ seek: 1, play: 0 });
  });

  test('paused host state stops an already-playing viewer immediately', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 102, target: 100, paused: true, currentRate: 1.25 });

    expect(calls.pause).toBeGreaterThan(0);
    expect(calls.rates).toContain(1);
  });

  test('manual Sync me remains an explicit hard resync', async ({ page }) => {
    await page.goto('/');
    const calls = await page.evaluate(() => {
      roomId = 'drift-room';
      state = {
        hostId: 'host-member',
        source: { type: 'youtube', videoId: 'M7lc1UVf-VE', originalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
        playback: { paused: false, position: 100, rate: 1, updatedAt: Date.now(), projectedAt: Date.now() },
        members: [], messages: []
      };
      session = { memberId: 'viewer-member' };
      ytPlayerReady = true;
      const seek = [];
      ytPlayer = {
        getVideoData: () => ({ video_id: 'M7lc1UVf-VE' }),
        getCurrentTime: () => 96,
        getPlayerState: () => 1,
        getPlaybackRate: () => 1,
        setPlaybackRate: () => {},
        seekTo: value => seek.push(value),
        playVideo: () => {},
        pauseVideo: () => {},
        setVolume: () => {},
        isMuted: () => false,
        mute: () => {},
        unMute: () => {}
      };
      document.getElementById('syncBtn').click();
      return seek;
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(100);
  });
});
