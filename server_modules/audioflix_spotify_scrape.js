/* Metadata-only Spotify playlist extractor used by the local EveOS Python bridge. */
'use strict';

const { chromium } = require('playwright');
const crypto = require('node:crypto');
const fs = require('node:fs');

const mode = process.argv[2] || 'scrape';
const playlistUrl = process.argv[3] || '';
const profileDir = process.argv[4] || '';
const statusPath = process.argv[5] || '';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const durationSeconds = (value) => {
    const parts = clean(value).split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
};
const trackId = (value) => clean(value).match(/(?:spotify:track:|\/track\/)([A-Za-z0-9]{10,})/)?.[1] || '';
const playlistIdFromUrl = (value) => clean(value).match(/playlist\/([A-Za-z0-9]+)/)?.[1] || '';
const matchKey = (value) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stableId = (row, position) => trackId(row.url || row.uri)
    || crypto.createHash('sha1').update(`${row.title}|${row.artist}|${position}`).digest('hex').slice(0, 22);
const playlistCount = (value) => {
    // Spotify's playlist header includes a duration summary (for example
    // "135 songs, about 7 hr"). Do not trust arbitrary "N songs" strings from
    // the rest of the Web Player: Library/sidebar counters can be much larger.
    const text = clean(value);
    const summary = text.match(/\b([\d,]+)\s+(?:songs?|tracks?)\s*,?\s*(?:about\s+)?(?:(?:\d+\s*(?:hr|hrs|hours?))(?:\s+\d+\s*(?:min|mins|minutes?))?|(?:\d+\s*(?:min|mins|minutes?)))\b/i);
    if (!summary) return 0;
    const count = Number(summary[1].replace(/,/g, ''));
    return Number.isFinite(count) && count > 0 ? count : 0;
};
const isEmbedPlaylistUrl = (value) => /open\.spotify\.com\/embed\/playlist\//i.test(clean(value));
const fullPlaylistUrl = (value) => {
    const id = playlistIdFromUrl(value);
    return id ? `https://open.spotify.com/playlist/${id}` : clean(value);
};
const needsFullPlayerPromotion = (value, expectedCount = 0, capturedCount = 0) => (
    isEmbedPlaylistUrl(value)
    && (Number(expectedCount) > 100 || (!Number(expectedCount) && Number(capturedCount) >= 100))
);
const assessPlaylistCompleteness = (expectedCount = 0, capturedCount = 0) => {
    const expected = Math.max(0, Number(expectedCount) || 0);
    const captured = Math.max(0, Number(capturedCount) || 0);
    if (!expected || captured >= expected) {
        return { ok: true, expectedCount: expected, capturedCount: captured, unexposedCount: 0 };
    }

    const shortfall = expected - captured;
    // Spotify can count a removed/region-blocked item in the playlist total without exposing a
    // usable track row. Always tolerate exactly one missing row after a complete scan; for larger
    // playlists we also allow the existing tiny <=2% gap (up to three rows). Real truncation such
    // as 8/135, or 16/18, remains blocked.
    const tolerance = Math.min(3, Math.max(1, Math.ceil(expected * 0.02)));
    const singleUnavailable = captured > 0 && shortfall === 1;
    const nearComplete = captured > 0
        && captured / expected >= 0.97
        && shortfall <= tolerance;
    const acceptable = singleUnavailable || nearComplete;
    return {
        ok: acceptable,
        expectedCount: expected,
        capturedCount: captured,
        unexposedCount: acceptable ? shortfall : 0,
        shortfall
    };
};
const shouldPromoteEmbedAfterScan = (value, expectedCount = 0, capturedCount = 0) => {
    if (!isEmbedPlaylistUrl(value)) return false;
    const captured = Math.max(0, Number(capturedCount) || 0);
    if (!captured) return true;
    if (needsFullPlayerPromotion(value, expectedCount, captured)) return true;
    const expected = Math.max(0, Number(expectedCount) || 0);
    return expected > 0 && !assessPlaylistCompleteness(expected, captured).ok;
};

function requestMentionsPlaylist(url = '', postData = '', playlistId = '') {
    if (!playlistId) return false;
    const values = [url, postData].map((value) => {
        const raw = String(value || '');
        try { return `${raw}\n${decodeURIComponent(raw)}`; } catch { return raw; }
    });
    const haystack = values.join('\n');
    return haystack.includes(playlistId)
        || haystack.includes(`spotify:playlist:${playlistId}`)
        || haystack.includes(`/playlist/${playlistId}`);
}

function writeLaunchStatus(value) {
    if (!statusPath) return;
    try {
        fs.writeFileSync(statusPath, JSON.stringify(value), 'utf8');
    } catch {}
}

async function launchContext() {
    const options = {
        headless: mode !== 'login',
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--window-position=80,80',
            '--window-size=1280,900'
        ]
    };
    if (process.platform === 'win32') {
        try {
            return await chromium.launchPersistentContext(profileDir, { ...options, channel: 'msedge' });
        } catch (edgeError) {
            try {
                return await chromium.launchPersistentContext(profileDir, options);
            } catch (chromiumError) {
                throw new Error(`Could not open the saved Spotify browser profile. Edge: ${edgeError.message}. Chromium: ${chromiumError.message}`);
            }
        }
    }
    return chromium.launchPersistentContext(profileDir, options);
}

function mergeTrack(base = {}, overlay = {}) {
    base = base && typeof base === 'object' ? base : {};
    overlay = overlay && typeof overlay === 'object' ? overlay : {};
    const artists = overlay.artists?.length ? overlay.artists : (base.artists || []);
    const durationMs = Number(overlay.durationMs || base.durationMs || 0);
    const id = overlay.id || base.id || trackId(overlay.url || base.url);
    return {
        id,
        title: clean(overlay.title || overlay.name || base.title || base.name || 'Unknown track'),
        artists: [...new Set(artists.map(clean).filter(Boolean))],
        artist: clean(artists.join(', ')),
        album: clean(overlay.album || base.album),
        image: clean(overlay.image || base.image),
        duration: durationMs > 0 ? durationMs / 1000 : durationSeconds(overlay.durationText || base.durationText),
        explicit: Boolean(overlay.explicit || base.explicit),
        url: clean(overlay.url || overlay.spotifyUrl || base.url || base.spotifyUrl || (id ? `https://open.spotify.com/track/${id}` : ''))
    };
}

function rowIdentity(row = {}) {
    const id = clean(row.id) || trackId(row.url || row.uri);
    if (id) return `id:${id}`;
    const title = matchKey(row.title || row.name);
    const artist = matchKey(row.artist || row.artists?.join(' '));
    return title ? `meta:${title}|${artist}` : '';
}

function mergePlaylistRows(domRows = [], networkTracks = new Map(), expectedCount = 0) {
    const networkRows = networkTracks instanceof Map ? [...networkTracks.values()] : [...(networkTracks || [])];
    if (!domRows.length) return expectedCount ? networkRows.slice(0, expectedCount) : networkRows;

    const networkByIdentity = new Map(networkRows.map((row) => [rowIdentity(row), row]).filter(([key]) => key));
    const enrichedDom = domRows.map((row) => mergeTrack(networkByIdentity.get(rowIdentity(row)), row));
    const firstIdentity = rowIdentity(enrichedDom[0]);
    const anchor = firstIdentity ? networkRows.findIndex((row) => rowIdentity(row) === firstIdentity) : -1;

    // Spotify's Web Player frequently ships the whole playlist in a JSON response while rendering
    // only a small virtualized window in the DOM. Anchor that response on the first visible song so
    // unrelated player/sidebar metadata before the playlist cannot become imported tracks.
    if (expectedCount > enrichedDom.length && anchor >= 0 && networkRows.length - anchor >= expectedCount) {
        const domByIdentity = new Map(enrichedDom.map((row) => [rowIdentity(row), row]).filter(([key]) => key));
        return networkRows.slice(anchor, anchor + expectedCount)
            .map((row) => mergeTrack(row, domByIdentity.get(rowIdentity(row))));
    }

    const merged = [...enrichedDom];
    const seen = new Set(merged.map(rowIdentity).filter(Boolean));
    if (anchor >= 0) {
        for (const row of networkRows.slice(anchor)) {
            const key = rowIdentity(row);
            if (!key || seen.has(key)) continue;
            merged.push(row);
            seen.add(key);
            if (expectedCount && merged.length >= expectedCount) break;
        }
    }
    return merged;
}

function scanValue(value, tracks, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || depth > 14 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((entry) => scanValue(entry, tracks, depth + 1, seen));
        return;
    }
    const candidates = [
        value.uri, value.trackUri, value.spotifyUri, value.external_urls?.spotify,
        value.externalUrls?.spotify, value.spotifyUrl, value.url, value.href
    ];
    let id = candidates.map(trackId).find(Boolean) || '';
    if (!id && typeof value.id === 'string' && /^(track|Track|TRACK)$/.test(value.type || value.__typename || value.contentType || '')) id = value.id;
    if (id) {
        const rawArtists = value.artists?.items || value.artists?.nodes || value.artists || value.artist || value.performers || [];
        const artists = (Array.isArray(rawArtists) ? rawArtists : [rawArtists])
            .map((entry) => entry?.node || entry?.profile || entry)
            .map((entry) => typeof entry === 'string' ? entry : entry?.name || entry?.title)
            .filter(Boolean);
        const imageSources = value.album?.images || value.albumOfTrack?.coverArt?.sources || value.images || [];
        const image = (Array.isArray(imageSources) ? imageSources : [imageSources])
            .map((entry) => entry?.url || entry?.src).find(Boolean) || '';
        const row = mergeTrack(tracks.get(id), {
            id,
            title: value.name || value.title || value.trackName,
            artists,
            album: value.album?.name || value.albumOfTrack?.name || value.albumName,
            image,
            durationMs: value.duration_ms || value.durationMs || value.duration?.totalMilliseconds,
            explicit: value.explicit || value.contentRating?.label === 'EXPLICIT',
            url: `https://open.spotify.com/track/${id}`
        });
        tracks.set(id, row);
    }
    Object.values(value).forEach((child) => scanValue(child, tracks, depth + 1, seen));
}

async function extractRows(page) {
    return page.evaluate(() => {
        const tidy = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 220
                && rect.height >= 24 && rect.height <= 130 && rect.bottom > 0 && rect.top < innerHeight;
        };
        const output = [];
        const used = new Set();
        document.querySelectorAll("[data-testid^='tracklist-row'],[role='row'],[role='listitem'],li").forEach((seed) => {
            let row = seed;
            for (let depth = 0; row && depth < 5; depth += 1, row = row.parentElement) {
                if (!visible(row)) continue;
                const raw = String(row.innerText || '');
                const durations = raw.match(/\b\d{1,3}:\d{2}\b/g) || [];
                if (durations.length !== 1) continue;
                const lines = raw.split(/\n+/).map(tidy).filter(Boolean)
                    .filter((line) => !/^(play|pause|more|saved on spotify|preview|explicit|e)$/i.test(line));
                const durationText = durations[0];
                const texts = lines.filter((line) => line !== durationText && !/^\d{1,4}$/.test(line));
                const link = row.querySelector("a[href*='/track/']");
                const titleNode = row.querySelector("[data-testid='internal-track-link'],[data-testid*='title'],a[href*='/track/']");
                const artists = [...row.querySelectorAll("a[href*='/artist/']")].map((a) => tidy(a.textContent)).filter(Boolean);
                const title = tidy(titleNode?.textContent) || texts[0] || '';
                if (!title) break;
                if (!artists.length && texts[1]) artists.push(texts[1]);
                const url = link?.href || link?.getAttribute('href') || '';
                const key = `${title.toLowerCase()}|${artists.join(',').toLowerCase()}|${durationText}`;
                if (!used.has(key)) {
                    used.add(key);
                    output.push({
                        id: (url.match(/\/track\/([A-Za-z0-9]{10,})/) || [])[1] || '',
                        title, artists, album: tidy(row.querySelector("a[href*='/album/']")?.textContent),
                        image: row.querySelector('img')?.currentSrc || row.querySelector('img')?.src || '',
                        durationText, explicit: /\bexplicit\b/i.test(raw) || lines.includes('E'), url
                    });
                }
                break;
            }
        });
        return output;
    });
}

async function markScrollTarget(page) {
    return page.evaluate(() => {
        document.querySelectorAll('[data-eve-spotify-scroll]').forEach((element) => element.removeAttribute('data-eve-spotify-scroll'));
        const rowSelector = "[data-testid^='tracklist-row'],[role='row']";
        const candidates = [...document.querySelectorAll('*')].map((element) => {
            const style = getComputedStyle(element);
            const range = element.scrollHeight - element.clientHeight;
            if (!/(auto|scroll)/.test(style.overflowY) || range <= 80) return null;
            return { element, range, rows: element.querySelectorAll(rowSelector).length };
        }).filter(Boolean).sort((a, b) => {
            const rowPreference = Number(b.rows > 0) - Number(a.rows > 0);
            if (rowPreference) return rowPreference;
            if (b.rows !== a.rows) return b.rows - a.rows;
            return b.range - a.range;
        });
        const target = candidates[0]?.element;
        if (target) target.dataset.eveSpotifyScroll = '1';
        const rect = target?.getBoundingClientRect();
        const height = target?.clientHeight || innerHeight;
        return {
            height,
            maximum: Math.max(0, (target?.scrollHeight || document.documentElement.scrollHeight) - height),
            position: target?.scrollTop || scrollY || 0,
            x: rect ? Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2)) : innerWidth / 2,
            y: rect ? Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2)) : innerHeight / 2
        };
    });
}

async function collectDomRows(page, expectedCount = 0) {
    const collected = new Map();
    const deadline = Date.now() + 90000;
    let dimensions = await markScrollTarget(page);
    let unchanged = 0;
    let reachedBottom = false;
    while (Date.now() < deadline) {
        let additions = 0;
        for (const row of await extractRows(page)) {
            const key = row.id || `${row.title.toLowerCase()}|${row.artists.join(',').toLowerCase()}|${row.durationText}`;
            if (!collected.has(key)) additions += 1;
            collected.set(key, { ...(collected.get(key) || {}), ...row });
        }
        unchanged = additions ? 0 : unchanged + 1;
        if (expectedCount && collected.size >= expectedCount) {
            reachedBottom = true;
            break;
        }
        const atBottom = dimensions.position >= Math.max(0, dimensions.maximum - 2);
        const stableLimit = expectedCount && collected.size < expectedCount ? 8 : 3;
        if (atBottom && unchanged >= stableLimit) {
            reachedBottom = true;
            break;
        }

        const step = Math.max(320, Math.floor(dimensions.height * 0.75));
        await page.evaluate((delta) => {
            const target = document.querySelector('[data-eve-spotify-scroll="1"]');
            if (target) {
                target.scrollTop = Math.min(target.scrollHeight - target.clientHeight, target.scrollTop + delta);
                target.dispatchEvent(new Event('scroll', { bubbles: true }));
            } else {
                scrollBy(0, delta);
            }
        }, step);
        await page.waitForTimeout(350);
        let next = await markScrollTarget(page);

        // If direct scrollTop writes do not move Spotify's virtual scroller, send a real wheel event
        // over the selected viewport. OverlayScrollbars/React virtualization responds to this path.
        if (next.position <= dimensions.position + 1 && unchanged >= 2) {
            await page.mouse.move(next.x, next.y).catch(() => {});
            await page.mouse.wheel(0, step).catch(() => {});
            await page.waitForTimeout(350);
            next = await markScrollTarget(page);
        }
        dimensions = next;
    }
    if (!reachedBottom) {
        throw new Error(`Spotify playlist scan timed out after collecting ${collected.size} tracks. Nothing was imported; keep the saved Spotify session signed in and retry.`);
    }
    return [...collected.values()];
}

async function header(page) {
    return page.evaluate(() => {
        const tidy = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const headings = [...document.querySelectorAll('h1,h2,[role="heading"]')].map((node) => tidy(node.textContent)).filter((value) => value && !/spotify/i.test(value));
        const lines = String(document.body.innerText || '').split(/\n+/).map(tidy).filter(Boolean);
        const title = headings[0] || '';
        const index = lines.indexOf(title);
        const owner = index >= 0 ? lines.slice(index + 1, index + 5).find((line) => !/saved on spotify|playlist|preview/i.test(line) && !/\d+:\d+/.test(line)) || '' : '';
        const images = [...document.querySelectorAll('img')].map((img) => ({ url: img.currentSrc || img.src, area: img.width * img.height })).sort((a, b) => b.area - a.area);
        return { title, owner, image: images[0]?.url || '' };
    });
}

async function scrape(context) {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    const targetPlaylistId = playlistIdFromUrl(playlistUrl);
    const network = new Map();
    const playlistNetwork = new Map();
    const pendingNetwork = new Set();
    page.on('response', (response) => {
        const task = (async () => {
            try {
                const type = String(response.headers()['content-type'] || '');
                if (response.status() < 400 && response.url().includes('spotify') && (type.includes('json') || /graphql|pathfinder|api/.test(response.url()))) {
                    const body = await response.text();
                    if (body.length < 12000000) {
                        const payload = JSON.parse(body);
                        scanValue(payload, network);
                        const request = response.request();
                        if (requestMentionsPlaylist(response.url(), request.postData() || '', targetPlaylistId)) {
                            scanValue(payload, playlistNetwork);
                        }
                    }
                }
            } catch {}
        })();
        pendingNetwork.add(task);
        task.finally(() => pendingNetwork.delete(task));
    });
    async function loadPage(url) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4500);
        const body = await page.locator('body').innerText().catch(() => '');
        for (const script of await page.locator('script').allTextContents()) {
            if (script.length < 12000000 && /spotify:track:|\/track\//.test(script)) {
                try { scanValue(JSON.parse(script), network); } catch {}
            }
        }
        return { body, expectedCount: playlistCount(body) };
    }
    async function settleAndResetCapture() {
        await Promise.allSettled([...pendingNetwork]);
        network.clear();
        playlistNetwork.clear();
    }
    const accessFailed = (body) => /page not found|can.?t seem to find/i.test(body)
        || (/log in|sign in/i.test(body) && !/\b\d{1,3}:\d{2}\b/.test(body));
    function assertAccessible(body) {
        if (/page not found|can.?t seem to find/i.test(body)) {
            throw new Error('Spotify could not open this playlist in EveOS. It may be private, deleted, or owned by another account. Open the saved Spotify session, sign in to an account that can view it, confirm the playlist loads there, then import again.');
        }
        if (/log in|sign in/i.test(body) && !/\b\d{1,3}:\d{2}\b/.test(body)) {
            throw new Error('Spotify login is required. Open the saved Spotify session first.');
        }
    }
    let scrapeSource = isEmbedPlaylistUrl(playlistUrl) ? 'embed' : 'saved-session';
    let loaded = await loadPage(playlistUrl);
    const embedExpectedCount = loaded.expectedCount;
    async function promoteToFullPlayer() {
        await settleAndResetCapture();
        scrapeSource = 'saved-session';
        const full = await loadPage(fullPlaylistUrl(playlistUrl));
        if (!full.expectedCount) full.expectedCount = embedExpectedCount;
        return full;
    }
    if (scrapeSource === 'embed' && (accessFailed(loaded.body)
        || needsFullPlayerPromotion(playlistUrl, loaded.expectedCount))) {
        loaded = await promoteToFullPlayer();
    }
    assertAccessible(loaded.body);
    let dom = await collectDomRows(page, loaded.expectedCount);
    if (scrapeSource === 'embed'
        && shouldPromoteEmbedAfterScan(playlistUrl, loaded.expectedCount, dom.length)) {
        loaded = await promoteToFullPlayer();
        assertAccessible(loaded.body);
        dom = await collectDomRows(page, loaded.expectedCount);
    }
    await Promise.allSettled([...pendingNetwork]);
    const scopedNetwork = playlistNetwork.size ? playlistNetwork : network;
    const rows = mergePlaylistRows(dom, scopedNetwork, loaded.expectedCount);
    const seen = new Set();
    const entries = rows.map((row, index) => {
        const sourceId = stableId(row, index + 1);
        return { ...row, sourceId, position: index + 1 };
    }).filter((row) => row.title && row.url && !seen.has(row.sourceId) && seen.add(row.sourceId));
    if (!entries.length) {
        const sourceHint = scrapeSource === 'saved-session'
            ? 'The saved Spotify session opened the playlist but exposed no usable song rows.'
            : 'Spotify exposed the playlist shell but no usable song rows.';
        throw new Error(`${sourceHint} Open Saved Session, verify the songs themselves are visible there, close that window, then import again.`);
    }
    const completeness = assessPlaylistCompleteness(loaded.expectedCount, entries.length);
    if (!completeness.ok) {
        throw new Error(`Spotify says this playlist has ${loaded.expectedCount} songs, but EveOS captured only ${entries.length}. The partial import was cancelled; reopen the saved Spotify session and retry.`);
    }
    const meta = await header(page);
    return {
        ok: true,
        playlistId: targetPlaylistId,
        title: meta.title || 'Spotify Playlist',
        owner: meta.owner,
        image: meta.image || entries[0].image,
        count: entries.length,
        expectedCount: completeness.expectedCount || entries.length,
        unexposedCount: completeness.unexposedCount,
        scrapeSource,
        entries
    };
}

async function main() {
    if (!playlistUrl || !profileDir) throw new Error('Missing Spotify playlist or profile path.');
    const context = await launchContext();
    if (mode === 'login') {
        writeLaunchStatus({ ok: true, pid: process.pid, openedAt: Date.now(), url: playlistUrl });
        const page = context.pages()[0] || await context.newPage();
        await page.goto(`https://accounts.spotify.com/login?continue=${encodeURIComponent(playlistUrl)}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => page.goto(playlistUrl));
        await new Promise((resolve) => context.on('close', resolve));
        return;
    }
    try { process.stdout.write(JSON.stringify(await scrape(context))); }
    finally { await context.close(); }
}

if (require.main === module) {
    main().catch((error) => {
        const failure = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        writeLaunchStatus(failure);
        process.stdout.write(JSON.stringify(failure));
        process.exitCode = 1;
    });
}

module.exports = {
    mergeTrack,
    mergePlaylistRows,
    playlistCount,
    requestMentionsPlaylist,
    needsFullPlayerPromotion,
    assessPlaylistCompleteness,
    shouldPromoteEmbedAfterScan,
    collectDomRows
};
