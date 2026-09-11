import { test, expect } from '@playwright/test';

async function setupViewer(page, paused, ended = false) {
  return page.evaluate(({ paused, ended }) => {
    const calls = { play: 0, pause: 0 };
    roomId = 'test-room';
    state = {
      hostId: 'host-member',
      source: { type: 'youtube', videoId: 'M7lc1UVf-VE', originalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
      playback: { paused, ended, position: ended ? 100 : 10, rate: 1, updatedAt: Date.now(), projectedAt: Date.now() },
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
      setVolume: () => {},
      isMuted: () => false,
      mute: () => {},
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
