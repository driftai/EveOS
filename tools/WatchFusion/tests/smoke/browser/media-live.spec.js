import { test, expect } from '@playwright/test';

const liveUrl = process.env.LIVE_MEDIA_URL;
const EXPECTED_BROWSER_HLS_FIXTURE = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

test('Live external media URL loads and advances in the WatchParty media adapter', async ({ page }) => {
  test.skip(!liveUrl, 'Set LIVE_MEDIA_URL to run the live external media smoke.');
  test.setTimeout(60000);
  await page.goto('/');
  const result = await page.evaluate(async url => {
    $('lobby').hidden = true;
    $('app').hidden = false;
    roomId = 'LIVE1';
    state = {
      hostId: 'other-host',
      source: { kind: 'media', type: /\.m3u8(?:$|[?#])/i.test(url) ? 'hls' : 'file', url, title: 'Live media smoke' },
      playback: { paused: false, ended: false, position: 0, rate: 1 }
    };
    session = { memberId: 'viewer' };
    let ok = false;
    let error = null;
    try { ok = await window.mediaPlayback.ensureSource(state.source); }
    catch (e) { error = e?.message || String(e); }
    if (ok && mediaVideo) {
      mediaVideo.muted = true;
      try { await mediaVideo.play(); } catch (e) { error = error || e?.message || String(e); }
    }
    return { ok, error };
  }, liveUrl);

  await expect(page.locator('#mediaVideo')).toBeVisible({ timeout: 10000 });
  const status = await page.evaluate(() => ({
    text: document.querySelector('#status')?.textContent || '',
    ready: !!mediaPlayerReady,
    readyState: mediaVideo?.readyState || 0,
    paused: !!mediaVideo?.paused,
    networkState: mediaVideo?.networkState || 0,
    currentTime: mediaVideo?.currentTime || 0
  }));

  if (!result.ok || /403|forbidden|CORS|blocked/i.test(`${result.error || ''} ${status.text}`)) {
    throw new Error(`Browser could not access the supplied external media source. This is a source/CDN compatibility failure, not a WatchParty player certification result. URL=${liveUrl} error=${result.error || status.text || 'unknown'}`);
  }

  await expect.poll(() => page.evaluate(() => ({
    ready: !!mediaPlayerReady,
    readyState: mediaVideo?.readyState || 0,
    paused: !!mediaVideo?.paused
  })), { timeout: 15000 }).toMatchObject({ ready: true, paused: false });

  const firstPosition = await page.evaluate(() => mediaVideo?.currentTime || 0);
  await expect.poll(() => page.evaluate(() => mediaVideo?.currentTime || 0), { timeout: 12000 }).toBeGreaterThan(firstPosition + 0.25);
});


test('Browser HLS certification fixture is the documented CORS-compatible Mux stream', async ({ page }) => {
  test.skip(process.env.SKIP_HLS_FIXTURE === '1');
  test.setTimeout(60000);
  await page.goto('/');
  await page.evaluate(async url => {
    $('lobby').hidden = true;
    $('app').hidden = false;
    roomId = 'HLS1';
    state = { hostId: 'other-host', source: { kind: 'media', type: 'hls', url, title: 'Browser HLS fixture' }, playback: { paused: false, ended: false, position: 0, rate: 1 } };
    session = { memberId: 'fixture-viewer' };
    const ok = await window.mediaPlayback.ensureSource(state.source);
    if (!ok) throw new Error('Documented browser HLS fixture failed to initialize.');
    mediaVideo.muted = true;
    await mediaVideo.play();
  }, EXPECTED_BROWSER_HLS_FIXTURE);
  await expect(page.locator('#mediaVideo')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => page.evaluate(() => ({ ready: !!mediaPlayerReady, paused: !!mediaVideo?.paused })), { timeout: 20000 }).toMatchObject({ ready: true, paused: false });
  const first = await page.evaluate(() => mediaVideo.currentTime || 0);
  await expect.poll(() => page.evaluate(() => mediaVideo.currentTime || 0), { timeout: 15000 }).toBeGreaterThan(first + 0.25);
});
