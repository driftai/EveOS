import { test, expect } from '@playwright/test';

test('external media host replay resets the local terminal player before publishing play', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const calls = [];
    const video = ensureMediaElement();
    let current = 42;
    let duration = 42;
    let ended = true;
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => current, set: value => { current = Number(value) || 0; } });
    Object.defineProperty(video, 'duration', { configurable: true, get: () => duration });
    Object.defineProperty(video, 'ended', { configurable: true, get: () => ended });

    window.command = (type, payload) => calls.push({ type, payload });
    roomId = 'test-room';
    state = {
      hostId: 'host-member',
      source: { kind: 'media', type: 'hls', url: 'https://example.com/video/master.m3u8' },
      playback: { paused: true, ended: true, position: duration, rate: 1, updatedAt: Date.now(), projectedAt: Date.now() },
      members: [], messages: []
    };
    session = { memberId: 'host-member' };

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      current = duration;
      ended = true;
      state.playback = { paused: true, ended: true, position: duration, rate: 1, updatedAt: cycle * 10, projectedAt: cycle * 10 };
      onMediaEnded();

      state.playback = { paused: false, ended: false, position: 0, rate: 1, updatedAt: cycle * 10 + 1, projectedAt: cycle * 10 + 1 };
      ended = true;
      video.dispatchEvent(new Event('play'));

      if (current !== 0) throw new Error(`cycle ${cycle}: terminal media element did not reset to 0`);
      if (calls.at(-1)?.type !== 'play' || calls.at(-1)?.payload?.position !== 0) {
        throw new Error(`cycle ${cycle}: replay did not publish play at 0`);
      }
    }
    return calls;
  });

  expect(result.filter(call => call.type === 'pause')).toHaveLength(3);
  expect(result.filter(call => call.type === 'play')).toHaveLength(3);
  expect(result.filter(call => call.type === 'play').every(call => call.payload.position === 0)).toBe(true);
});
