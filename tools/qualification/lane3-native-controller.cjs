'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function waitForCdp(port, child, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = 'not ready';
    while (Date.now() < deadline) {
        if (child.exitCode != null) throw new Error(`Native Chromium exited before CDP became ready (${child.exitCode})`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
            const payload = response.ok ? await response.json() : null;
            if (payload?.webSocketDebuggerUrl) return payload.webSocketDebuggerUrl;
            last = `HTTP ${response.status}`;
        } catch (error) { last = error?.message || String(error); }
        await sleep(100);
    }
    throw new Error(`Native Chromium CDP did not become ready: ${last}`);
}

async function terminate(child) {
    if (!child || child.exitCode != null) return;
    try { child.kill('SIGTERM'); } catch {}
    const deadline = Date.now() + 3000;
    while (child.exitCode == null && Date.now() < deadline) await sleep(50);
    if (child.exitCode == null) {
        try { child.kill('SIGKILL'); } catch {}
    }
}

async function launch(options = {}) {
    const port = await freePort();
    const profileRoot = options.profileRoot || path.join(os.tmpdir(), 'eveos-qualification');
    fs.mkdirSync(profileRoot, { recursive: true });
    const profile = fs.mkdtempSync(path.join(profileRoot, 'lane3-native-'));
    const executable = chromium.executablePath();
    const child = spawn(executable, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', '--new-window', 'about:blank'
    ], { stdio: 'ignore', windowsHide: false, detached: false });

    let browser;
    try {
        const endpoint = await waitForCdp(port, child);
        browser = await chromium.connectOverCDP(endpoint);
    } catch (error) {
        await terminate(child);
        fs.rmSync(profile, { recursive: true, force: true });
        throw error;
    }

    const close = browser.close.bind(browser);
    let closing = false;
    browser.close = async () => {
        if (closing) return;
        closing = true;
        try { await close(); } catch {}
        await terminate(child);
        fs.rmSync(profile, { recursive: true, force: true });
    };
    browser.__eveNativeController = { pid: child.pid, port, temporaryProfile: true };
    return browser;
}

module.exports = { launch };
