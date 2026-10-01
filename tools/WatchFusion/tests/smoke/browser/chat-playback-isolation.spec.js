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

    let youtubeSyncCalls = 0;
    let mediaSyncCalls = 0;
    const originalSyncPlayer = syncPlayer;
    const originalFetch = window.fetch;
    const originalMediaPlayback = window.mediaPlayback;
    syncPlayer = () => { youtubeSyncCalls += 1; };
    window.mediaPlayback = { ...(originalMediaPlayback || {}), sync: () => { mediaSyncCalls += 1; } };
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
      return { ok, youtubeSyncCalls, mediaSyncCalls };
    } finally {
      window.fetch = originalFetch;
      window.mediaPlayback = originalMediaPlayback;
      syncPlayer = originalSyncPlayer;
    }
  });

  expect(result.ok).toBe(true);
  expect(result.youtubeSyncCalls).toBe(0);
  expect(result.mediaSyncCalls).toBe(0);
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


test('chat history stays put when a new message arrives while reading older messages', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(() => {
    roomId = 'CHATSCROLL1';
    session = { memberId: 'viewer-member', publicId: 'viewer-public' };
    const now = Date.now();
    state = {
      roomId,
      hostId: 'host-public',
      revision: 1,
      source: { kind: 'ready' },
      playback: { paused: true, ended: false, position: 0, rate: 1, updatedAt: now, projectedAt: now },
      members: [{ id: 'viewer-public', name: 'Phone', isOwner: false }],
      messages: Array.from({ length: 30 }, (_, index) => ({
        id: `msg-${index}`,
        memberId: 'viewer-public',
        name: 'Phone',
        text: `history line ${index} ${'x'.repeat(80)}`,
        at: now + index
      }))
    };

    const chat = document.getElementById('chat');
    chat.style.height = '150px';
    chat.style.maxHeight = '150px';
    render();
    chat.scrollTop = Math.min(120, Math.max(0, chat.scrollHeight - chat.clientHeight - 120));
    chat.dispatchEvent(new Event('scroll'));
    const before = chat.scrollTop;

    state = {
      ...state,
      revision: 2,
      messages: [...state.messages, {
        id: 'msg-new',
        memberId: 'viewer-member',
        name: 'Phone',
        text: 'new message',
        at: now + 100
      }]
    };
    render();

    return {
      before,
      after: chat.scrollTop,
      max: Math.max(0, chat.scrollHeight - chat.clientHeight)
    };
  });

  expect(Math.abs(result.after - result.before)).toBeLessThanOrEqual(1);
  expect(result.after).toBeLessThan(result.max - 20);
});


test('fresh room images are prioritized while older history remains lazy', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(() => {
    roomId = 'IMGFAST1';
    session = { memberId: 'viewer-member', publicId: 'viewer-public' };
    const now = Date.now();
    const image = index => ({
      id: `img-msg-${index}`,
      memberId: 'viewer-public',
      name: 'Phone',
      text: '',
      attachment: { id: `att-${index}`, name: `shot-${index}.png`, type: 'image/png', size: 128, url: `/api/rooms/IMGFAST1/attachments/att-${index}` },
      at: now + index
    });
    state = {
      roomId,
      hostId: 'viewer-public',
      revision: 1,
      source: { kind: 'ready' },
      playback: { paused: true, ended: false, position: 0, rate: 1, updatedAt: now, projectedAt: now },
      members: [{ id: 'viewer-public', name: 'Phone', isOwner: true }],
      messages: [image(1), image(2), image(3)]
    };
    render();
    const images = [...document.querySelectorAll('#chat .message-image')];
    return images.map(node => ({
      loading: node.getAttribute('loading'),
      priority: node.getAttribute('fetchpriority'),
      decoding: node.getAttribute('decoding')
    }));
  });

  expect(result).toEqual([
    { loading: 'lazy', priority: 'auto', decoding: 'async' },
    { loading: 'eager', priority: 'high', decoding: 'async' },
    { loading: 'eager', priority: 'high', decoding: 'async' }
  ]);
});
