/* Metadata-only Spotify playlist extractor used by the local EveOS Python bridge. */
'use strict';

const { chromium } = require('playwright');
const crypto = require('node:crypto');
const fs = require('node:fs');

const mode = process.argv[2] || 'scrape';
const embedUrl = process.argv[3] || '';
const profileDir = process.argv[4] || '';
const statusPath = process.argv[5] || '';
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const durationSeconds = (value) => {
    const parts = clean(value).split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
};
const trackId = (value) => clean(value).match(/(?:spotify:track:|\/track\/)([A-Za-z0-9]{10,})/)?.[1] || '';
const matchKey = (value) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stableId = (row, position) => trackId(row.url || row.uri)
    || crypto.createHash('sha1').update(`${row.title}|${row.artist}|${position}`).digest('hex').slice(0, 22);

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
        const pattern = /\b\d{1,3}:\d{2}\b/;
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

async function collectDomRows(page) {
    const collected = new Map();
    const deadline = Date.now() + 540000;
    let dimensions = await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('*')].filter((element) => {
            const style = getComputedStyle(element);
            return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 80;
        }).sort((a, b) => b.scrollHeight - a.scrollHeight);
        const target = candidates[0];
        if (target) target.dataset.eveSpotifyScroll = '1';
        return { height: target?.clientHeight || innerHeight, maximum: Math.max(0, (target?.scrollHeight || document.documentElement.scrollHeight) - (target?.clientHeight || innerHeight)) };
    });
    let position = 0;
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
        if (position >= dimensions.maximum && unchanged >= 2) {
            reachedBottom = true;
            break;
        }
        position = Math.min(dimensions.maximum, position + Math.max(180, Math.floor(dimensions.height * 0.7)));
        await page.evaluate((next) => {
            const target = document.querySelector('[data-eve-spotify-scroll="1"]');
            if (target) target.scrollTop = next;
            else scrollTo(0, next);
        }, position);
        await page.waitForTimeout(300);
        dimensions = await page.evaluate(() => {
            const target = document.querySelector('[data-eve-spotify-scroll="1"]');
            const height = target?.clientHeight || innerHeight;
            return {
                height,
                maximum: Math.max(0, (target?.scrollHeight || document.documentElement.scrollHeight) - height)
            };
        });
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
    const network = new Map();
    page.on('response', async (response) => {
        try {
            const type = String(response.headers()['content-type'] || '');
            if (response.status() < 400 && response.url().includes('spotify') && (type.includes('json') || /graphql|pathfinder|api/.test(response.url()))) {
                const body = await response.text();
                if (body.length < 12000000) scanValue(JSON.parse(body), network);
            }
        } catch {}
    });
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4500);
    const body = await page.locator('body').innerText().catch(() => '');
    if (/page not found|can.?t seem to find/i.test(body)) {
        throw new Error('Spotify could not open this playlist in EveOS. It may be private, deleted, or owned by another account. Open the saved Spotify session, sign in to an account that can view it, confirm the playlist loads there, then import again.');
    }
    if (/log in|sign in/i.test(body) && !/\b\d{1,3}:\d{2}\b/.test(body)) throw new Error('Spotify login is required. Open the saved Spotify session first.');
    for (const script of await page.locator('script').allTextContents()) {
        if (script.length < 12000000 && /spotify:track:|\/track\//.test(script)) {
            try { scanValue(JSON.parse(script), network); } catch {}
        }
    }
    const dom = await collectDomRows(page);
    const byTitle = new Map();
    for (const value of network.values()) {
        const key = matchKey(value.title);
        if (key) byTitle.set(key, [...(byTitle.get(key) || []), value]);
    }
    const rows = dom.length ? dom.map((row) => {
        const candidates = byTitle.get(matchKey(row.title)) || [];
        const artistKey = matchKey(row.artist || row.artists?.join(' '));
        const matched = network.get(row.id)
            || candidates.find((entry) => artistKey && matchKey(entry.artist).includes(artistKey))
            || (candidates.length === 1 ? candidates[0] : null);
        return mergeTrack(matched, row);
    }) : [...network.values()];
    const seen = new Set();
    const entries = rows.map((row, index) => {
        const sourceId = stableId(row, index + 1);
        return { ...row, sourceId, position: index + 1 };
    }).filter((row) => row.title && row.url && !seen.has(row.sourceId) && seen.add(row.sourceId));
    if (!entries.length) throw new Error('No Spotify song rows were found. Open the saved session, verify the playlist is visible, then sync again.');
    const meta = await header(page);
    return { ok: true, playlistId: embedUrl.match(/playlist\/([A-Za-z0-9]+)/)?.[1] || '', title: meta.title || 'Spotify Playlist', owner: meta.owner, image: meta.image || entries[0].image, count: entries.length, entries };
}

async function main() {
    if (!embedUrl || !profileDir) throw new Error('Missing Spotify playlist or profile path.');
    const context = await launchContext();
    if (mode === 'login') {
        writeLaunchStatus({ ok: true, pid: process.pid, openedAt: Date.now(), url: embedUrl });
        const page = context.pages()[0] || await context.newPage();
        await page.goto(`https://accounts.spotify.com/login?continue=${encodeURIComponent(embedUrl)}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => page.goto(embedUrl));
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

module.exports = { mergeTrack, collectDomRows };
