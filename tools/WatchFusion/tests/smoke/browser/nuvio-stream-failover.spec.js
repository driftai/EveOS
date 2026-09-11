import { test, expect } from '@playwright/test';

test.describe('Nuvio Stream Failover & Dead Link Recovery End-to-End Suite', () => {
  test('Dead stream candidate automatically fails over to next candidate and reaches ready state', async ({ page }) => {
    await page.goto('/');
    await page.click('#headerToggleBtn');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const nuvioFrameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await nuvioFrameElement.contentFrame();

    const testResult = await nuvioFrame.evaluate(async () => {
      const win = window;
      const doc = document;

      // Define Candidate A (dead / failed stream) and Candidate B (valid stream)
      const candidateA = {
        id: 'stream-cand-a-dead',
        name: 'All-in-One-Nuvio - VidEasy',
        title: 'VidEasy | Vimeos | Dual-Audio',
        url: 'https://s9.vimeos.net/hls2/03/00012/7wcprvd9l080_,n,h,.urlset/master.m3u8?t=dead&s=1788252117&e=43200'
      };

      const candidateB = {
        id: 'stream-cand-b-working',
        name: 'VidSrc Pro CDN',
        title: 'VidSrc | Server 2 | 1080p',
        url: 'https://cdn.example.com/movies/sample-1080p/master.m3u8'
      };

      const mockPlayer = {
        streamCandidates: [candidateA, candidateB],
        currentStreamIndex: 0,
        activePlaybackUrl: candidateA.url,
        failedPlaybackUrls: new win.Set(),
        failedPlaybackStreamIds: new win.Set(),
        mountToken: 1,
        clearPlaybackStallGuard() {},
        getCurrentStreamCandidate() {
          return this.streamCandidates[this.currentStreamIndex];
        },
        markPlaybackSourceFailed(url, cand) {
          if (url) this.failedPlaybackUrls.add(String(url).trim());
          if (cand?.id) this.failedPlaybackStreamIds.add(String(cand.id).trim());
        },
        showStartupError(msg, ctx = {}) {
          this.markPlaybackSourceFailed(ctx.playbackUrl || this.activePlaybackUrl, ctx.streamCandidate || this.getCurrentStreamCandidate());
          let errEl = doc.getElementById('playerStartupErrorOverlay');
          if (!errEl) {
            errEl = doc.createElement('div');
            errEl.id = 'playerStartupErrorOverlay';
            doc.body.appendChild(errEl);
          }
          errEl.className = 'player-startup-error-overlay';
          errEl.style.display = 'block';
        },
        playStreamCandidate(cand, opts = {}) {
          this.activePlaybackUrl = cand.url;
          this.currentStreamIndex = this.streamCandidates.findIndex(c => c.id === cand.id);
        }
      };

      await new Promise(resolve => {
        const check = () => {
          if (win.watchFusionStreamFailover) resolve();
          else setTimeout(check, 50);
        };
        check();
      });

      win.PlayerScreen = mockPlayer;
      win.watchFusionStreamFailover?.reset();

      // Trigger candidate A failure
      mockPlayer.showStartupError('Playback error', {
        streamCandidate: candidateA,
        playbackUrl: candidateA.url,
        reason: 'startup-stall'
      });

      // Execute failover check
      win.watchFusionStreamFailover?.checkAndAutoAdvanceFailedStream();

      await new Promise(r => setTimeout(r, 600));

      const history = win.__watchFusionFailoverHistory || win.watchFusionStreamFailover?.history || [];
      const activeCandidate = mockPlayer.streamCandidates[mockPlayer.currentStreamIndex];
      const failedUrls = Array.from(mockPlayer.failedPlaybackUrls || []);
      const failedIds = Array.from(mockPlayer.failedPlaybackStreamIds || []);

      return {
        ok: true,
        currentIndex: mockPlayer.currentStreamIndex,
        activeUrl: mockPlayer.activePlaybackUrl,
        activeCandidateTitle: activeCandidate?.title,
        activeCandidateId: activeCandidate?.id,
        failedUrls,
        failedIds,
        historyCount: history.length,
        lastFailover: history[history.length - 1] || null
      };
    });

    console.log('FAILOVER TEST RESULT:', testResult);

    expect(testResult.ok).toBe(true);
    expect(testResult.currentIndex).toBe(1);
    expect(testResult.activeCandidateId).toBe('stream-cand-b-working');
    expect(testResult.activeUrl).toBe('https://cdn.example.com/movies/sample-1080p/master.m3u8');
    expect(testResult.failedUrls).toContain('https://s9.vimeos.net/hls2/03/00012/7wcprvd9l080_,n,h,.urlset/master.m3u8?t=dead&s=1788252117&e=43200');
    expect(testResult.failedIds).toContain('stream-cand-a-dead');
    expect(testResult.historyCount).toBeGreaterThanOrEqual(1);
  });

  test('Auto-failover halts and prevents infinite loop when all stream candidates fail', async ({ page }) => {
    await page.goto('/');
    await page.click('#headerToggleBtn');
    await page.click('#shortcutNuvioBtn');
    await expect(page.locator('#nuvioFrame')).toBeVisible();

    const nuvioFrameElement = await page.waitForSelector('#nuvioFrame');
    const nuvioFrame = await nuvioFrameElement.contentFrame();

    const loopResult = await nuvioFrame.evaluate(async () => {
      const win = window;
      const doc = document;

      const candidate1 = { id: 'cand-1', url: 'https://bad1.com/stream.m3u8', title: 'Bad 1' };
      const candidate2 = { id: 'cand-2', url: 'https://bad2.com/stream.m3u8', title: 'Bad 2' };

      const mockPlayer = {
        streamCandidates: [candidate1, candidate2],
        currentStreamIndex: 0,
        activePlaybackUrl: candidate1.url,
        failedPlaybackUrls: new win.Set(),
        failedPlaybackStreamIds: new win.Set(),
        mountToken: 1,
        clearPlaybackStallGuard() {},
        getCurrentStreamCandidate() {
          return this.streamCandidates[this.currentStreamIndex];
        },
        markPlaybackSourceFailed(url, cand) {
          if (url) this.failedPlaybackUrls.add(String(url).trim());
          if (cand?.id) this.failedPlaybackStreamIds.add(String(cand.id).trim());
        },
        showStartupError(msg, ctx = {}) {
          this.markPlaybackSourceFailed(ctx.playbackUrl || this.activePlaybackUrl, ctx.streamCandidate || this.getCurrentStreamCandidate());
          let errEl = doc.getElementById('playerStartupErrorOverlay');
          if (!errEl) {
            errEl = doc.createElement('div');
            errEl.id = 'playerStartupErrorOverlay';
            doc.body.appendChild(errEl);
          }
          errEl.className = 'player-startup-error-overlay';
          errEl.style.display = 'block';
        },
        playStreamCandidate(cand, opts = {}) {
          this.activePlaybackUrl = cand.url;
          this.currentStreamIndex = this.streamCandidates.findIndex(c => c.id === cand.id);
        }
      };

      await new Promise(resolve => {
        const check = () => {
          if (win.watchFusionStreamFailover) resolve();
          else setTimeout(check, 50);
        };
        check();
      });

      win.PlayerScreen = mockPlayer;
      win.watchFusionStreamFailover?.reset();

      // Fail candidate 1
      mockPlayer.showStartupError('Error 1', { streamCandidate: candidate1, playbackUrl: candidate1.url, reason: 'startup-stall' });
      win.watchFusionStreamFailover?.checkAndAutoAdvanceFailedStream();
      await new Promise(r => setTimeout(r, 400));

      // Fail candidate 2
      mockPlayer.showStartupError('Error 2', { streamCandidate: candidate2, playbackUrl: candidate2.url, reason: 'startup-stall' });
      win.watchFusionStreamFailover?.checkAndAutoAdvanceFailedStream();
      await new Promise(r => setTimeout(r, 400));

      // Call again to verify it does NOT loop back to candidate 1
      win.watchFusionStreamFailover?.checkAndAutoAdvanceFailedStream();
      await new Promise(r => setTimeout(r, 400));

      const attempts = win.watchFusionStreamFailover?.attempts || 0;
      const history = win.watchFusionStreamFailover?.history || [];

      return {
        ok: true,
        attempts,
        historyLength: history.length,
        failedUrlsCount: mockPlayer.failedPlaybackUrls.size
      };
    });

    console.log('LOOP TEST RESULT:', loopResult);

    expect(loopResult.ok).toBe(true);
    expect(loopResult.attempts).toBeLessThanOrEqual(2);
    expect(loopResult.historyLength).toBe(1);
    expect(loopResult.failedUrlsCount).toBe(2);
  });
});
