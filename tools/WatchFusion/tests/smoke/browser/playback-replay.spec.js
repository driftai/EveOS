import { test, expect } from '@playwright/test';

test('repeated host END -> Replay cycles survive remote-sync guard and restart at zero', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const calls = [];
    roomId = 'test-room';
    state = {
      hostId: 'host-member',
      source: { type: 'youtube', videoId: 'M7lc1UVf-VE', originalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
      playback: { paused: false, ended: false, position: 9.9, rate: 1, updatedAt: Date.now(), projectedAt: Date.now() },
      members: [], messages: []
    };
    session = { memberId: 'host-member' };
    ytPlayerReady = true;
    window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 } };

    let current = 9.9;
    let playerState = window.YT.PlayerState.PLAYING;
    ytPlayer = {
      getVideoData: () => ({ video_id: 'M7lc1UVf-VE' }),
      getCurrentTime: () => current,
      getDuration: () => 10,
      getPlayerState: () => playerState,
      setPlaybackRate: () => {},
      seekTo: value => { current = value; },
      playVideo: () => { playerState = window.YT.PlayerState.PLAYING; },
      pauseVideo: () => { playerState = window.YT.PlayerState.PAUSED; },
      setVolume: () => {},
      isMuted: () => false,
      mute: () => {},
      unMute: () => {}
    };

    const originalCommand = command;
    command = async (type, extra = {}) => {
      calls.push({ type, extra });
      if (type === 'play') {
        state.playback = { ...state.playback, paused: false, ended: false, position: Number(extra.position) || 0 };
      } else if (type === 'pause') {
        state.playback = { ...state.playback, paused: true, ended: !!extra.ended, position: Number(extra.position) || 0 };
      }
      return true;
    };

    try {
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        // Real natural completion event.
        current = 10;
        playerState = window.YT.PlayerState.ENDED;
        applyingRemote = false;
        onYouTubeStateChange({ data: window.YT.PlayerState.ENDED });
        await new Promise(resolve => setTimeout(resolve, 0));

        if (!state.playback.paused || !state.playback.ended) {
          throw new Error(`cycle ${cycle}: END did not become authoritative ended state`);
        }

        // Real YouTube Replay transition, deliberately arriving while the
        // short remote-apply guard is active.
        current = 10;
        playerState = window.YT.PlayerState.PLAYING;
        applyingRemote = true;
        onYouTubeStateChange({ data: window.YT.PlayerState.PLAYING });
        await new Promise(resolve => setTimeout(resolve, 0));
        applyingRemote = false;

        if (state.playback.paused || state.playback.ended || state.playback.position !== 0) {
          throw new Error(`cycle ${cycle}: Replay did not restart authoritative state at zero`);
        }
      }
      return calls;
    } finally {
      command = originalCommand;
      applyingRemote = false;
    }
  });

  expect(result.filter(item => item.type === 'pause' && item.extra.ended === true)).toHaveLength(3);
  expect(result.filter(item => item.type === 'play' && Number(item.extra.position) === 0)).toHaveLength(3);
});
