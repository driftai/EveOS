'use strict';
// Native lifecycle qualification must not inherit Playwright's forced-focus CDP capturer.
// The binary is still the installed Playwright Chromium; this is not a production launch path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch(directory, { forceBundledWs = false } = {}) {
    const native = !forceBundledWs && typeof globalThis.WebSocket === 'function';
    // Node 20 does not consistently provide global WebSocket. Reuse the pinned Playwright bundle.
    const Socket = native ? globalThis.WebSocket : require('playwright-core/lib/utilsBundle').ws;
    assert.equal(typeof Socket, 'function', 'native CDP fixture requires the existing WebSocket transport');
    assert.equal(typeof Socket.prototype.addEventListener, 'function', 'CDP transport must support EventTarget listeners');
    const child = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--no-first-run',
        '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
        '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'browser-profile')}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    let log = '', socket, sequence = 0;
    const pending = new Map(), listeners = new Map();
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    function send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
    async function waitClosed(timeout) {
        let timer;
        const done = await Promise.race([closed.then(() => true),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); })]);
        clearTimeout(timer); return done;
    }
    async function close() {
        if (socket?.readyState === Socket.OPEN) await send('Browser.close').catch(() => {});
        if (!await waitClosed(5000)) child.kill('SIGTERM');
        assert.ok(await waitClosed(3000), 'session-owned Chromium failed to exit; preserve its temporary profile');
        socket?.close();
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP closed')); }
        pending.clear();
    }
    try {
        const deadline = Date.now() + 15000;
        while (!/DevTools listening on (ws:\/\/\S+)/.test(log)) {
            assert.ok(child.exitCode == null && Date.now() < deadline, `isolated Chromium did not start: ${log.slice(-1200)}`);
            await sleep(30);
        }
        socket = new Socket(log.match(/DevTools listening on (ws:\/\/\S+)/)[1]);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        socket.addEventListener('message', event => {
            const message = JSON.parse(String(event.data));
            if (message.id) {
                const request = pending.get(message.id); if (!request) return;
                pending.delete(message.id); clearTimeout(request.timer);
                if (message.error) request.reject(new Error(message.error.message));
                else request.resolve(message.result);
            } else {
                for (const callback of listeners.get(message.sessionId) || []) callback(message);
            }
        });
        const version = await send('Browser.getVersion');
        return { version: version.product, webSocketTransport: native ? 'node-global' : 'playwright-bundled-ws',
            close, async page(url, onEvent) {
            const { browserContextId } = await send('Target.createBrowserContext');
            const { targetId } = await send('Target.createTarget', { browserContextId, url: 'about:blank' });
            const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
            listeners.set(sessionId, new Set([onEvent]));
            const command = (method, params) => send(method, params, sessionId);
            await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
            await command('Page.navigate', { url });
            async function evaluate(fn, arg) {
                const result = await command('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg)})`,
                    returnByValue: true, awaitPromise: true });
                if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
                return result.result.value;
            }
            async function wait(predicate, timeout = 4000) {
                const deadline = Date.now() + timeout;
                while (!await evaluate(predicate)) {
                    assert.ok(Date.now() < deadline, 'fixture predicate timed out'); await sleep(20);
                }
            }
            await wait(() => Boolean(window.__fixture));
            return { send: command, evaluate, wait, async click(selector) {
                const point = await evaluate(sel => {
                    const rect = document.querySelector(sel)?.getBoundingClientRect();
                    return rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
                        width: rect.width, height: rect.height };
                }, selector);
                assert.ok(point?.width > 0 && point.height > 0, `real pointer target must have geometry: ${selector}`);
                for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
                    await command('Input.dispatchMouseEvent', { type, x: point.x, y: point.y,
                        ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
                }
            }, async screenshot(file) {
                const image = await command('Page.captureScreenshot'); fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
            }, async close() {
                listeners.delete(sessionId); await send('Target.disposeBrowserContext', { browserContextId });
            } };
        } };
    } catch (error) { await close(); throw error; }
}

module.exports = { launch };
