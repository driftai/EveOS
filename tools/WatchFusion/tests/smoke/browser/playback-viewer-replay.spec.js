import { test, expect } from '@playwright/test';

test('viewer terminal YouTube state restarts on authoritative replay across repeated cycles', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(() => {
    const calls = { seek: 0, play: 0, pause: 0, load: [] };
    let current = 10;
    let playerState = 0;

    window.YT = { PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2 } };
    roomId = 'test-room';
    state = {
      hostId: 'host-member',
      source: { type: 'youtube', videoId: 'M7lc1UVf-VE' },
      playback: { paused: true, ended: true, position: 10, rate: 1, updatedAt: 1, projectedAt: 1 },
      members: [], messages: []
    };
    session = { memberId: 'viewer-member' };
    ytPlayerReady = true;
    ytPlayer = {
      getVideoData: () => ({ video_id: 'M7lc1UVf-VE' }),
      getCurrentTime: () => current,
      getPlaybackRate: () => 1,
      setPlaybackRate: () => {},
      // Model the real failure class: terminal players can ignore a plain seek.
      seekTo: value => {
        calls.seek += 1;
        if (playerState !== window.YT.PlayerState.ENDED) current = value;
      },
      playVideo: () => { calls.play += 1; },
      pauseVideo: () => { calls.pause += 1; },
      loadVideoById: value => {
        calls.load.push(value);
        current = Number(value.startSeconds) || 0;
        playerState = window.YT.PlayerState.PLAYING;
      },
      setVolume: () => {},
      isMuted: () => false,
      mute: () => {},
      unMute: () => {}
    };

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const now = Date.now() + cycle * 1000;
      state.playback = {
        paused: true, ended: true, position: 10, rate: 1,
        updatedAt: now, projectedAt: now
      };
      syncPlayer();

      state.playback = {
        paused: false, ended: false, position: 0, rate: 1,
        updatedAt: now + 1, projectedAt: now + 1
      };
      syncPlayer();

      if (playerState !== window.YT.PlayerState.PLAYING || current > 0.5) {
        throw new Error(`cycle ${cycle}: viewer remained terminal after authoritative replay`);
      }

      current = 10;
      playerState = window.YT.PlayerState.ENDED;
    }

    return calls;
  });

  expect(result.load).toHaveLength(3);
  expect(result.load.every(call => call.videoId === 'M7lc1UVf-VE')).toBe(true);
  expect(result.load.every(call => Number(call.startSeconds) <= 1.5)).toBe(true);
});
