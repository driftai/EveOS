import { test, expect } from '@playwright/test';

async function createRoom(page, code) {
  await page.goto('/');
  await page.click('#headerToggleBtn');
  await page.click('#startPartyBtn');
  await page.fill('#nameInput', 'RealtimeHost');
  await page.fill('#roomInput', code);
  await page.click('#createBtn');
  await expect(page).toHaveURL(/\/watch\//, { timeout: 5000 });
  await expect(page.locator('#roomPill')).not.toHaveText('Solo', { timeout: 5000 });
}

test('room clients establish the preferred WebSocket realtime transport', async ({ page }) => {
  await createRoom(page, '822');
  await expect.poll(() => page.evaluate(() => window.watchPartyRealtime?.connected?.() === true), { timeout: 5000 }).toBe(true);
  await expect(page.locator('#syncStatus')).toContainText('Connected');
});

test('a second browser receives room state over WebSocket', async ({ browser }) => {
  const host = await browser.newPage();
  await createRoom(host, '823');
  const roomUrl = host.url();

  const viewer = await browser.newPage();
  await viewer.addInitScript(() => localStorage.setItem('wp-name', 'WSViewer'));
  await viewer.goto(roomUrl);
  await expect(viewer.locator('#app')).toBeVisible();
  await expect.poll(() => viewer.evaluate(() => window.watchPartyRealtime?.connected?.() === true), { timeout: 5000 }).toBe(true);
  await expect(viewer.locator('#members')).toContainText('WSViewer');
  await expect(host.locator('#members')).toContainText('WSViewer');

  await host.close();
  await viewer.close();
});

test('falls back to SSE when WebSocket is unavailable without changing room semantics', async ({ browser }) => {
  const host = await browser.newPage();
  await createRoom(host, '824');
  const roomUrl = host.url();

  const viewer = await browser.newPage();
  await viewer.addInitScript(() => {
    class BlockedWebSocket {
      static OPEN = 1;
      constructor() { this.readyState = 0; setTimeout(() => this.onerror?.(new Error('blocked')), 0); setTimeout(() => { this.readyState = 3; this.onclose?.(); }, 1); }
      close() { this.readyState = 3; }
      send() {}
    }
    window.WebSocket = BlockedWebSocket;
  });
  await viewer.goto(roomUrl);
  await expect(viewer.locator('#app')).toBeVisible();
  await expect.poll(() => viewer.evaluate(() => eventSource?.readyState === 1), { timeout: 5000 }).toBe(true);
  await expect(viewer.locator('#members')).toContainText('RealtimeHost');

  await host.close();
  await viewer.close();
});

test('rejects a stale WebSocket snapshot after a newer authoritative revision', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static OPEN = 1;
      constructor() { this.readyState = 1; window.__fakeWs = this; setTimeout(() => this.onopen?.(), 0); }
      send(payload) { window.__fakeWsLastSent = payload; }
      close() { this.readyState = 3; }
    }
    window.WebSocket = FakeWebSocket;
  });
  await createRoom(page, '825');
  await page.evaluate(() => {
    const base = structuredClone(state);
    state.revision = 10;
    window.watchPartyRealtime?.resetRevision?.(10);
    const staleState = structuredClone(base);
    staleState.revision = 8;
    staleState.source = { type: 'youtube', videoId: 'stale_id' };
    window.__fakeWs.onmessage({ data: JSON.stringify({ type: 'state', state: staleState }) });
  });

  const source = await page.evaluate(() => state.source);
  expect(source?.videoId).not.toBe('stale_id');
});
