'use strict';

const path = require('node:path');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE_URL = 'file:///' + path.join(ROOT, 'EveOS.html').replace(/\\/g, '/');

function silentWav() {
    const rate = 8000, count = rate * 20;
    const wav = Buffer.alloc(44 + count * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
    return `data:audio/wav;base64,${wav.toString('base64')}`;
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
        await page.addInitScript(() => {
            try { localStorage.clear(); } catch {}
            window.__eveSmokeNoAutoGemini = true;
        });
        await page.goto(FILE_URL, { waitUntil: 'load', timeout: 180000 });
        await page.waitForFunction(() => window.EveAudioflix?.ready && window.EveAudioflixState?.ready,
            undefined, { timeout: 120000 });

        await page.evaluate((src) => {
            const S = window.EveAudioflixState;
            S.addMusicGroup('Supersession Contract');
            for (const title of ['Before', 'Candidate', 'After']) {
                const item = S.addItem('music', { title, url: src, folder: 'Supersession Contract' });
                S.toggleMusicGroup(item.id, 'Supersession Contract', true);
            }
        }, silentWav());

        await page.click('.topbar-audioflix-btn');
        await page.waitForSelector('#audioflix-overlay:not([hidden]) .audioflix-panel', { timeout: 10000 });
        await page.click('[data-af-action="tab"][data-af-tab="music"]');
        await page.click('[data-af-action="toggle-view-mode"]');
        await page.click('[data-af-action="select-frontend-group"][data-af-type="music"][data-af-group="Supersession Contract"]');
        await page.click('[data-af-action="play-music-group"]');
        await page.waitForFunction(() => {
            const q = window.EveAudioflix?.queueConnection?.snapshot?.();
            return q?.groupName === 'Supersession Contract' && q.currentIndex === 0 && q.isPlaying === true;
        }, undefined, { timeout: 10000 });

        const result = await page.evaluate(async () => {
            const q = window.EveAudioflix.queueConnection;
            const audio = window.EveAudioflixAudio;
            const before = q.snapshot();
            const skippedCount = () => Number(
                window.EveAudioflixDiagnostics?.snapshot?.()?.summary?.['queue:skipped-start']?.count || 0
            );
            const skippedBefore = skippedCount();
            const originalPlay = audio.playItem;
            const originalInternal = audio.openInternalView;
            audio.playItem = async () => false;
            audio.openInternalView = async () => false;
            try {
                await q.step(1);
            } finally {
                audio.playItem = originalPlay;
                audio.openInternalView = originalInternal;
            }
            return { before, after: q.snapshot(), skippedBefore, skippedAfter: skippedCount() };
        });

        assert.equal(result.after.currentIndex, result.before.currentIndex,
            'a superseded false start leaves the queue on the previously authoritative index');
        assert.equal(result.after.isPlaying, result.before.isPlaying,
            'a superseded false start does not mark the queue failed');
        assert.deepEqual(result.after.entries, result.before.entries,
            'a superseded false start does not rewrite queue order/membership');
        assert.equal(result.skippedAfter, result.skippedBefore,
            'a superseded false start never records queue:skipped-start');
        console.log('AUDIOFLIX_QUEUE_SUPERSEDED_START_SMOKE_OK');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
