import { test, expect } from '@playwright/test';

function configureViewer(page, { current, target = 100, paused = false, rate = 1, samples = 1, currentRate = 1 }) {
  return page.evaluate(({ current, target, paused, rate, samples, currentRate }) => {
    const calls = { seek: [], rates: [], play: 0, pause: 0 };
    roomId = 'drift-room';
    state = {
      hostId: 'host-member',
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
      getVideoData: () => ({ video_id: 'M7lc1UVf-VE' }),
      getCurrentTime: () => current,
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
    const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    const began = performance.now();
    try {
      for (let index = 0; index < samples; index++) {
        Object.defineProperty(performance, 'now', { configurable: true, value: () => began + index * 250 });
        syncPlayer();
      }
    } finally {
      if (descriptor) Object.defineProperty(performance, 'now', descriptor);
      else delete performance.now;
    }
    calls.status = document.querySelector('#syncStatus').textContent;
    calls.diagnostics = window.watchFusionSyncDiagnostics();
    return calls;
  }, { current, target, paused, rate, samples, currentRate });
}

test.describe('Adaptive playback drift regression', () => {
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
    const calls = await configureViewer(page, { current: 99.97, target: 100, samples: 5 });

    expect(calls.seek).toEqual([]);
    expect(calls.rates).not.toContain(1.25);
    expect(calls.diagnostics.stable).toBe(true);
    expect(calls.diagnostics.action).toBe('steady');
  });

  test('stable fractional sensor drift preserves the host rate without seeking', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 99.82, target: 100, samples: 5 });

    expect(calls.seek).toEqual([]);
    expect(calls.rates).toEqual([]);
    expect(calls.diagnostics.stable).toBe(true);
    expect(calls.diagnostics.filteredDriftSec).toBeGreaterThan(0.15);
    expect(calls.diagnostics.action).toBe('steady');
  });

  test('filtered phase correction reports Re-synced then Connected after settling', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 99, target: 100, samples: 5 });
    expect(calls.seek).toHaveLength(1);
    expect(calls.rates).toEqual([1]);
    expect(calls.status).toBe('Re-synced');
    expect(calls.diagnostics.action).toBe('stable-seek');
    const statuses = await page.evaluate(() => {
      syncPlayer();
      const settled = document.querySelector('#syncStatus').textContent;
      setStatus('Re-synced');
      state.playback.paused = true;
      syncPlayer({ force: true });
      return { settled, paused: document.querySelector('#syncStatus').textContent };
    });

    expect(statuses.settled).toMatch(/^Connected/);
    expect(statuses.paused).toMatch(/^Connected/);
  });

  test('unsolicited room snapshots preserve measured server clock latency', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(() => {
      const midpoint = Date.now();
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
    const calls = await configureViewer(page, { current: 97, target: 100, samples: 2 });

    expect(calls.seek).toHaveLength(1);
    expect(calls.seek[0]).toBeGreaterThanOrEqual(100);
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
      syncPlayer({ force: true });
      return seek;
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(100);
  });
});
