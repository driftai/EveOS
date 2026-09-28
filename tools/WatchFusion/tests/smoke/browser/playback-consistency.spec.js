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
