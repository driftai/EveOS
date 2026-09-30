import { test, expect } from '@playwright/test';

test('viewer source hydration force-aligns a newly loaded YouTube video', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(() => {
    const videoId = 'dQw4w9WgXcQ';
    const seeks = [];
    let current = 8.9;

    roomId = 'source-switch-room';
    session = { memberId: 'viewer-member', publicId: 'viewer-public' };
    state = {
      hostId: 'host-public',
      revision: 8,
      serverTime: Date.now(),
      source: { type: 'youtube', videoId, originalUrl: `https://www.youtube.com/watch?v=${videoId}` },
      playback: {
        paused: false,
        ended: false,
        position: 10,
        rate: 1,
        volume: 100,
        muted: false,
        updatedAt: Date.now(),
        projectedAt: Date.now()
      },
      members: [],
      messages: []
    };

    userGesturePrimeUsed = true;
    autoplayWasBlocked = false;
    ytPlayerReady = true;
    ytPlayer = {
      getVideoData: () => ({ video_id: videoId }),
      getPlayerState: () => 1,
      getCurrentTime: () => current,
      getPlaybackRate: () => 1,
      setPlaybackRate: () => {},
      getVolume: () => 100,
      setVolume: () => {},
      isMuted: () => false,
      mute: () => {},
      unMute: () => {},
      playVideo: () => {},
      pauseVideo: () => {},
      seekTo: value => { current = value; seeks.push(value); }
    };

    const hydrated = syncHydratedPlayer(videoId);
    return { hydrated, seeks, current };
  });

  expect(result.hydrated).toBe(true);
  expect(result.seeks.length).toBeGreaterThan(0);
  expect(result.current).toBeGreaterThan(9.8);
});

test('stale source hydration cannot resync over a newer video', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(() => {
    let seeks = 0;
    roomId = 'source-switch-room';
    session = { memberId: 'viewer-member', publicId: 'viewer-public' };
    state = {
      hostId: 'host-public',
      source: { type: 'youtube', videoId: 'new-video-id' },
      playback: { paused: false, ended: false, position: 4, rate: 1, projectedAt: Date.now() }
    };
    ytPlayerReady = true;
    ytPlayer = {
      getVideoData: () => ({ video_id: 'new-video-id' }),
      getCurrentTime: () => 0,
      getPlayerState: () => 1,
      getPlaybackRate: () => 1,
      setPlaybackRate: () => {},
      getVolume: () => 100,
      setVolume: () => {},
      isMuted: () => false,
      mute: () => {},
      unMute: () => {},
      playVideo: () => {},
      pauseVideo: () => {},
      seekTo: () => { seeks += 1; }
    };
    return { accepted: syncHydratedPlayer('old-video-id'), seeks };
  });

  expect(result.accepted).toBe(false);
  expect(result.seeks).toBe(0);
});
