const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url, payload = null) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const body = payload == null ? '' : JSON.stringify(payload);
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            method: payload == null ? 'GET' : 'POST',
            headers: payload == null ? {} : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data || '{}'));
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function waitForStatus(url, timeoutMs = 60000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const payload = await requestJson(url);
            if (payload.status === 'ok') return;
        } catch {}
        await sleep(250);
    }
    throw new Error(`Timed out waiting for ${url}`);
}

function buildMusic(count, prefix) {
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-music-${index}`,
        title: `${prefix} Music ${index}`,
        url: `https://${prefix}.example/music/${index}`,
        type: 'music'
    }));
}

function buildRemoteState({ linkCount = 2, musicCount = 0 } = {}) {
    return {
        bookmarks: {
            links: Array.from({ length: linkCount }, (_, index) => ({
                id: `remote-${index}`,
                title: `Remote Bookmark ${index}`,
                url: `https://remote.example/${index}`,
                workspace: 'main',
                category: 'Remote'
            })),
            folders: {},
            pins: [],
            config: {
                activeWorkspace: 'main',
                viewMode: 'grid',
                modularStateSyncEnabled: true,
                modularStateConflictStrategy: 'remote_wins',
                workspaces: [{ id: 'main', name: 'Main', icon: 'M', subTabs: [] }]
            }
        },
        library: { categories: {}, connections: [] },
        knowledge: { scopedStorage: {} },
        audioflix: { music: buildMusic(musicCount, 'remote'), soundboard: [] }
    };
}

function buildLocalLinks(count = 60) {
    return Array.from({ length: count }, (_, index) => ({
        id: `local-${index}`,
        title: `Local Large Bookmark ${index}`,
        url: `https://local.example/${index}`,
        workspace: 'main',
        category: index % 2 ? 'Local A' : 'Local B',
        done: false
    }));
}

async function openLocalContext(browser, baseUrl, { links, music = [] }) {
    const context = await browser.newContext();
    await context.addInitScript(({ localLinks, localMusic }) => {
        const audioflix = { music: localMusic, soundboard: [] };
        localStorage.setItem('eveAudioflixFallbackState', JSON.stringify(audioflix));
        localStorage.setItem('eveV22Data', JSON.stringify(localLinks));
        localStorage.setItem('eveV22Config', JSON.stringify({
            activeWorkspace: 'main',
            viewMode: 'grid',
            modularStateSyncEnabled: true,
            modularStateConflictStrategy: 'remote_wins',
            workspaces: [{ id: 'main', name: 'Main', icon: 'M', subTabs: [] }],
            categoryOrder: ['Local A', 'Local B'],
            collapsed: [],
            collapsedTabs: [],
            audioflix
        }));
    }, { localLinks: links, localMusic: music });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/EveOS.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__eveCoreDataLoaded === true, undefined, { timeout: 180000 });
    await page.waitForFunction(() => window.EveDataStore?._modularSync?.state?.initialized === true, undefined, { timeout: 120000 });
    await sleep(2500);
    return { context, page };
}

(async () => {
    const port = await findFreePort();
    const modularRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-shrink-guard-'));
    const server = spawn('python', ['server/python-server.py', String(port), '--no-browser', '--modular-root', modularRoot], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    server.stdout.on('data', (chunk) => chunks.push(String(chunk)));
    server.stderr.on('data', (chunk) => chunks.push(String(chunk)));

    let browser = null;
    try {
        await waitForStatus(`http://localhost:${port}/api/status`);
        const baseUrl = `http://localhost:${port}`;
        const saved = await requestJson(`${baseUrl}/api/eve-state/modular/save`, buildRemoteState());
        if (!saved.ok) throw new Error(`Failed to seed remote state: ${JSON.stringify(saved)}`);

        browser = await chromium.launch({ headless: true });
        const localLinks = buildLocalLinks();
        const first = await openLocalContext(browser, baseUrl, { links: localLinks });

        const result = await first.page.evaluate(() => ({
            linkCount: window.eveState.links.length,
            renderedLinks: document.querySelectorAll('[data-link-id]').length,
            rejectedReason: window.EveDataStore?._modularSync?.state?.rejectedRemoteReason || '',
            loadSummary: window.__eveLastCoreDataLoadSummary || null,
            syncState: window.EveDataStore?._modularSync?.state || null,
            legacyLength: localStorage.getItem('eveV22Data')?.length || 0,
            titles: window.eveState.links.slice(0, 5).map((link) => link.title)
        }));
        if (result.linkCount < 50) {
            throw new Error(`Expected local state to survive remote shrink, got ${JSON.stringify(result)}`);
        }
        if (result.rejectedReason !== 'destructive-shrink') {
            throw new Error(`Expected destructive-shrink rejection, got ${JSON.stringify(result)}`);
        }
        await first.context.close();

        const localMusic = buildMusic(1180, 'local');
        const remoteAudioState = buildRemoteState({ linkCount: localLinks.length, musicCount: 60 });
        const audioSeed = await requestJson(`${baseUrl}/api/eve-state/modular/save`, remoteAudioState);
        if (!audioSeed.ok) throw new Error(`Failed to seed Audioflix shrink state: ${JSON.stringify(audioSeed)}`);
        const second = await openLocalContext(browser, baseUrl, { links: localLinks, music: localMusic });
        const guarded = await second.page.evaluate(() => ({
            linkCount: window.eveState.links.length,
            musicCount: window.EveAudioflixState?.ensure?.().music?.length || 0,
            rejectedReason: window.EveDataStore?._modularSync?.state?.rejectedRemoteReason || ''
        }));
        const pushed = await requestJson(`${baseUrl}/api/eve-state/modular/load`);
        if (guarded.linkCount !== localLinks.length || guarded.musicCount !== localMusic.length
            || guarded.rejectedReason !== 'destructive-audioflix-shrink') {
            throw new Error(`Audioflix shrink was not rejected without damaging local state: ${JSON.stringify(guarded)}`);
        }
        if ((pushed.state?.audioflix?.music || []).length !== localMusic.length) {
            throw new Error(`Rejected Audioflix shrink did not push preserved local state: ${JSON.stringify({
                remoteMusicCount: pushed.state?.audioflix?.music?.length || 0
            })}`);
        }

        await second.page.evaluate(() => window.EveDataStore._modularSync.stopPolling());
        const overrideSeed = await requestJson(`${baseUrl}/api/eve-state/modular/save`, remoteAudioState);
        const overrideApplied = await second.page.evaluate(async ({ signature }) => {
            const applied = await window.EveDataStore._modularSync.pullRemoteState(true, signature, {
                allowDestructiveRemoteApply: true
            });
            return {
                applied,
                musicCount: window.EveAudioflixState?.ensure?.().music?.length || 0
            };
        }, { signature: overrideSeed.status?.signature || '' });
        if (!overrideApplied.applied || overrideApplied.musicCount !== 60) {
            throw new Error(`Explicit destructive apply did not accept remote Audioflix state: ${JSON.stringify(overrideApplied)}`);
        }

        console.log('MODULAR_STARTUP_SHRINK_GUARD_BROWSER_SMOKE_OK');
        await second.context.close();
    } finally {
        if (browser) await browser.close();
        server.kill();
        await sleep(200);
        try { fs.rmSync(modularRoot, { recursive: true, force: true }); } catch {}
        if (server.exitCode && server.exitCode !== 0) {
            console.error(chunks.join(''));
        }
    }
})().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
