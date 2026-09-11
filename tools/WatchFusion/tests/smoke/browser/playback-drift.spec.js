import { test, expect } from '@playwright/test';

function configureViewer(page, { current, target = 100, paused = false, rate = 1 }) {
  return page.evaluate(({ current, target, paused, rate }) => {
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
      getPlaybackRate: () => 1,
      setPlaybackRate: value => calls.rates.push(value),
      seekTo: value => calls.seek.push(value),
      playVideo: () => { calls.play += 1; },
      pauseVideo: () => { calls.pause += 1; },
      setVolume: () => {},
      isMuted: () => false,
      mute: () => {},
      unMute: () => {}
    };
    syncPlayer();
    return calls;
  }, { current, target, paused, rate });
}

test.describe('Adaptive playback drift regression', () => {
  test('moderate viewer drift uses temporary supported playback rate without seeking', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 99, target: 100 });

    expect(calls.seek).toEqual([]);
    expect(calls.rates).toContain(1.25);
  });

  test('small viewer drift does not introduce an aggressive correction', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 99.7, target: 100 });

    expect(calls.seek).toEqual([]);
    expect(calls.rates).not.toContain(1.25);
  });

  test('large viewer drift uses one corrective seek instead of a repeated seek loop', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 97, target: 100 });

    expect(calls.seek).toHaveLength(1);
    expect(calls.seek[0]).toBeGreaterThanOrEqual(100);
  });

  test('paused host state stops an already-playing viewer immediately', async ({ page }) => {
    await page.goto('/');
    const calls = await configureViewer(page, { current: 102, target: 100, paused: true });

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
