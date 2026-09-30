import { test, expect } from '@playwright/test';

test('chat command does not re-enter playback synchronization', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    roomId = 'CHATPERF1';
    session = { memberId: 'viewer-member', publicId: 'viewer-public' };
    const now = Date.now();
    state = {
      roomId,
      hostId: 'host-public',
      revision: 1,
      serverTime: now,
      source: { type: 'youtube', kind: 'youtube', videoId: 'M7lc1UVf-VE', originalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
      playback: { paused: false, ended: false, position: 12, rate: 1, volume: 100, muted: false, updatedAt: now, projectedAt: now },
      members: [{ id: 'viewer-public', name: 'Phone', isOwner: false }],
      messages: []
    };

    let syncCalls = 0;
    const originalSync = syncPlaybackForAuthorityChange;
    const originalFetch = window.fetch;
    syncPlaybackForAuthorityChange = (...args) => {
      syncCalls += 1;
      return originalSync(...args);
    };
    window.fetch = async () => new Response(JSON.stringify({
      ok: true,
      state: {
        ...state,
        revision: 2,
        serverTime: now + 30,
        playback: { ...state.playback, position: 12.03, projectedAt: now + 30 },
        messages: [{ id: 'msg-1', memberId: 'viewer-public', name: 'Phone', text: 'hello', at: now + 30 }]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    try {
      const ok = await command('chat', { text: 'hello' });
      return { ok, syncCalls, authority: playbackAuthorityKey(state) };
    } finally {
      window.fetch = originalFetch;
      syncPlaybackForAuthorityChange = originalSync;
    }
  });

  expect(result.ok).toBe(true);
  expect(result.syncCalls).toBe(1);
});

test('same-source chat render does not rehydrate the active YouTube player', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(() => {
    roomId = 'CHATPERF2';
    session = { memberId: 'viewer-member', publicId: 'viewer-public' };
    const now = Date.now();
    state = {
      roomId,
      hostId: 'host-public',
      revision: 1,
      source: { type: 'youtube', kind: 'youtube', videoId: 'M7lc1UVf-VE', originalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' },
      playback: { paused: false, ended: false, position: 5, rate: 1, volume: 100, muted: false, updatedAt: now, projectedAt: now },
      members: [{ id: 'viewer-public', name: 'Phone', isOwner: false }],
      messages: []
    };

    let ensureCalls = 0;
    let clearCalls = 0;
    const originalEnsure = ensurePlayer;
    const originalMediaPlayback = window.mediaPlayback;
    const originalPlayer = ytPlayer;
    const originalReady = ytPlayerReady;
    ensurePlayer = () => { ensureCalls += 1; };
    window.mediaPlayback = { ...(originalMediaPlayback || {}), clear: () => { clearCalls += 1; } };
    ytPlayer = {};
    ytPlayerReady = true;

    try {
      render();
      state = {
        ...state,
        revision: 2,
        messages: [{ id: 'msg-1', memberId: 'viewer-public', name: 'Phone', text: 'hello', at: now + 20 }]
      };
      render();
      return { ensureCalls, clearCalls, chatCount: document.querySelectorAll('#chat .msg').length };
    } finally {
      ensurePlayer = originalEnsure;
      window.mediaPlayback = originalMediaPlayback;
      ytPlayer = originalPlayer;
      ytPlayerReady = originalReady;
    }
  });

  expect(result.ensureCalls).toBe(1);
  expect(result.clearCalls).toBe(1);
  expect(result.chatCount).toBe(1);
});
