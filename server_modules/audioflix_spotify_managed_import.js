'use strict';

/*
 * Spotify playlist extraction inside the already-running managed Playwright context.
 *
 * The managed EveOS page must stay alive while an import runs. Opening the existing
 * persistent profile in a second Chromium process would require stopping that page first,
 * which also destroys the browser request that initiated the import. Instead this module
 * opens one temporary Spotify page in the same BrowserContext and closes only that page.
 */

const crypto = require('node:crypto');
const {
    mergePlaylistRows,
    scanValue,
    playlistCount,
    requestMentionsPlaylist,
    assessPlaylistCompleteness,
    collectDomRows
} = require('./audioflix_spotify_scrape.js');

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const trackId = (value) => clean(value).match(/(?:spotify:track:|\/track\/)([A-Za-z0-9]{10,})/)?.[1] || '';
const playlistIdFromUrl = (value) => clean(value).match(/playlist\/([A-Za-z0-9]+)/)?.[1] || '';
const stableId = (row, position) => trackId(row.url || row.uri)
    || crypto.createHash('sha1').update(`${row.title}|${row.artist}|${position}`).digest('hex').slice(0, 22);

function normalizeManagedPlaylistUrl(value) {
    const raw = clean(value);
    let parsed;
    try { parsed = new URL(raw); } catch { return ''; }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'open.spotify.com') return '';
    if (!/^\/playlist\/[A-Za-z0-9]+(?:\/|$)/i.test(parsed.pathname)) return '';
    return parsed.href;
}

async function withManagedPlaylistPage(context, playlistUrl, worker) {
    const target = normalizeManagedPlaylistUrl(playlistUrl);
    if (!target) throw new Error('Managed Spotify import requires an open.spotify.com playlist URL.');
    const page = await context.newPage();
    try {
        return await worker(page, target);
    } finally {
        await page.close().catch(() => {});
    }
}

async function playlistHeader(page) {
    return page.evaluate(() => {
        const tidy = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const headings = [...document.querySelectorAll('h1,h2,[role="heading"]')]
            .map((node) => tidy(node.textContent)).filter((value) => value && !/spotify/i.test(value));
        const lines = String(document.body.innerText || '').split(/\n+/).map(tidy).filter(Boolean);
        const title = headings[0] || '';
        const index = lines.indexOf(title);
        const owner = index >= 0
            ? lines.slice(index + 1, index + 5)
                .find((line) => !/saved on spotify|playlist|preview/i.test(line) && !/\d+:\d+/.test(line)) || ''
            : '';
        const images = [...document.querySelectorAll('img')]
            .map((img) => ({ url: img.currentSrc || img.src, area: img.width * img.height }))
            .sort((a, b) => b.area - a.area);
        return { title, owner, image: images[0]?.url || '' };
    });
}

async function scrapeManagedPlaylist(context, playlistUrl) {
    return withManagedPlaylistPage(context, playlistUrl, async (page, target) => {
        page.setDefaultTimeout(15000);
        const targetPlaylistId = playlistIdFromUrl(target);
        const network = new Map();
        const playlistNetwork = new Map();
        const pendingNetwork = new Set();

        const onResponse = (response) => {
            const task = (async () => {
                try {
                    const type = String(response.headers()['content-type'] || '');
                    if (response.status() >= 400 || !response.url().includes('spotify')
                        || (!type.includes('json') && !/graphql|pathfinder|api/.test(response.url()))) return;
                    const body = await response.text();
                    if (body.length >= 12000000) return;
                    const payload = JSON.parse(body);
                    scanValue(payload, network);
                    const request = response.request();
                    if (requestMentionsPlaylist(response.url(), request.postData() || '', targetPlaylistId)) {
                        scanValue(payload, playlistNetwork);
                    }
                } catch {}
            })();
            pendingNetwork.add(task);
            task.finally(() => pendingNetwork.delete(task));
        };
        page.on('response', onResponse);

        try {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(4500);
            const title = await page.title().catch(() => '');
            if (/application error/i.test(title)) {
                throw new Error('Spotify player failed to initialize while importing this playlist.');
            }
            const body = await page.locator('body').innerText().catch(() => '');
            if (/page not found|can.?t seem to find/i.test(body)) {
                throw new Error('Spotify could not open this playlist in the saved account session.');
            }
            if (/log in|sign in/i.test(body) && !/\b\d{1,3}:\d{2}\b/.test(body)) {
                throw new Error('Spotify login is required in the managed Audioflix browser.');
            }

            for (const script of await page.locator('script').allTextContents()) {
                if (script.length < 12000000 && /spotify:track:|\/track\//.test(script)) {
                    try { scanValue(JSON.parse(script), network); } catch {}
                }
            }

            const expectedCount = playlistCount(body);
            const domRows = await collectDomRows(page, expectedCount);
            await Promise.allSettled([...pendingNetwork]);
            const scopedNetwork = playlistNetwork.size ? playlistNetwork : network;
            const rows = mergePlaylistRows(domRows, scopedNetwork, expectedCount);
            const seen = new Set();
            const entries = rows.map((row, index) => {
                const sourceId = stableId(row, index + 1);
                return { ...row, sourceId, position: index + 1 };
            }).filter((row) => row.title && row.url && !seen.has(row.sourceId) && seen.add(row.sourceId));

            if (!entries.length) {
                throw new Error('The managed Spotify session opened the playlist but exposed no usable song rows.');
            }
            const completeness = assessPlaylistCompleteness(expectedCount, entries.length);
            if (!completeness.ok) {
                throw new Error(`Spotify says this playlist has ${expectedCount} songs, but EveOS captured only ${entries.length}. The partial import was cancelled.`);
            }
            const meta = await playlistHeader(page);
            return {
                ok: true,
                playlistId: targetPlaylistId,
                title: meta.title || 'Spotify Playlist',
                owner: meta.owner,
                image: meta.image || entries[0].image,
                count: entries.length,
                expectedCount: completeness.expectedCount || entries.length,
                unexposedCount: completeness.unexposedCount,
                scrapeSource: 'managed-session',
                entries
            };
        } finally {
            page.off('response', onResponse);
        }
    });
}

module.exports = {
    normalizeManagedPlaylistUrl,
    withManagedPlaylistPage,
    scrapeManagedPlaylist
};
