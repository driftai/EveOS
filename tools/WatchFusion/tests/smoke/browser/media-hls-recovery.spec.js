import { test, expect } from '@playwright/test';

test('fatal HLS errors use bounded native recovery instead of leaving playback terminal', async ({ page }) => {
  await page.addInitScript(() => {
    class MockHls {
      static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest' };
      static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
      static isSupported() { return true; }
      static last = null;
      constructor() {
        this.handlers = new Map();
        MockHls.last = this;
        window.Hls.last = this;
        this.startCalls = 0;
        this.recoverCalls = 0;
      }
      on(event, handler) { this.handlers.set(event, handler); }
      loadSource() {}
      attachMedia(video) {
        Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
        setTimeout(() => video.dispatchEvent(new Event('loadedmetadata')), 0);
      }
      startLoad() { this.startCalls += 1; }
      recoverMediaError() { this.recoverCalls += 1; }
      destroy() {}
      emit(event, data) { this.handlers.get(event)?.(event, data); }
    }
    window.Hls = MockHls;
  });

  await page.goto('/');
  const result = await page.evaluate(async () => {
    state = {
      source: { kind: 'media', type: 'hls', url: 'https://example.com/master.m3u8' },
      playback: { paused: true, ended: false, position: 0, rate: 1, updatedAt: Date.now(), projectedAt: Date.now() },
      members: [], messages: []
    };
    session = { memberId: 'viewer' };
    await window.mediaPlayback.ensureSource(state.source);
    const hls = window.Hls.last;
    for (let i = 0; i < 3; i += 1) hls.emit(window.Hls.Events.ERROR, { fatal: true, type: window.Hls.ErrorTypes.NETWORK_ERROR });
    for (let i = 0; i < 3; i += 1) hls.emit(window.Hls.Events.ERROR, { fatal: true, type: window.Hls.ErrorTypes.MEDIA_ERROR });
    return { network: hls.startCalls, media: hls.recoverCalls };
  });

  expect(result.network).toBe(2);
  expect(result.media).toBe(2);
});
