#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { launchChromiumOrConnect } = require('../../../tools/smoke/playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TOOL = path.join(ROOT, 'tools', 'Nexus-Browser');
const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const room = (id, name) => ({
  id, name, userName: 'Local owner', members: [], messages: [],
  settings: { autoRelay: false, maxTurns: 2, contextMessages: 8,
    contextDefaultMessages: null, middleAgentMode: 'disabled', middleAgentMemberId: null },
  relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});

async function waitHealthy(port, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Disposable Nexus exited before health became ready.');
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Disposable Nexus did not become healthy.');
}

async function pointerClick(page, selector) {
  const locator = page.locator(selector);
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${selector} has no pointer geometry.`);
  await locator.click({ position: { x: box.width / 2, y: box.height / 2 } });
}

async function rawMutation(page, port, message, authorize = false) {
  return page.evaluate(({ portValue, input, decorate }) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${portValue}/ws`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('Raw viewer mutation timed out.')); }, 6000);
    let sent = false;
    const finish = (value) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(value); };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'ui', clientKind: 'browser',
      uiHolderId: globalThis.BrowserAiBridgeUiSocket?.uiHolderId })));
    ws.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      if (!sent && payload.type === 'server_session') {
        sent = true;
        const outbound = decorate
          ? (globalThis.BrowserAiBridgeMachineHumanGate?.authorize?.(input) || input) : input;
        ws.send(JSON.stringify(outbound));
        return;
      }
      if (sent && payload.requestId === input.requestId && payload.type === 'error') finish(payload);
    });
    ws.addEventListener('error', () => finish({ type: 'socket-error' }));
  }), { portValue: port, input: message, decorate: authorize });
}

async function main() {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-machine-human-gate-'));
  fs.writeFileSync(path.join(dataDir, 'dex-state.json'), JSON.stringify({
    version: 1,
    rooms: [room('room-viewer-one', 'Viewer One'), room('room-viewer-two', 'Viewer Two')],
    activeRoomId: 'room-viewer-one', retiredProviderControlReceipts: [], retiredRoomIds: [],
    savedAt: new Date().toISOString()
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: TOOL, windowsHide: true,
    env: { ...process.env, NEXUS_BROWSER_PORT: String(port), NEXUS_BROWSER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let tail = '';
  child.stdout.on('data', (value) => { tail = (tail + String(value)).slice(-8000); });
  child.stderr.on('data', (value) => { tail = (tail + String(value)).slice(-8000); });
  let browser = null;
  try {
    await waitHealthy(port, child);
    const headless = process.env.NEXUS_MACHINE_GATE_HEADLESS === '1';
    ({ browser } = await launchChromiumOrConnect({
      headless,
      channel: !headless && process.platform === 'win32' ? 'msedge' : undefined
    }));
    const context = await browser.newContext({ viewport: { width: 1320, height: 920 } });
    const primary = await context.newPage();
    const observer = await context.newPage();
    const errors = [];
    for (const page of [primary, observer]) page.on('pageerror', (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${port}/?mode=dex`;
    await primary.goto(url, { waitUntil: 'domcontentloaded' });
    await primary.locator('#dexRoomList .dex-room-item').first().waitFor({ state: 'visible' });
    await observer.goto(url, { waitUntil: 'domcontentloaded' });
    await observer.locator('#dexRoomList .dex-room-item').first().waitFor({ state: 'visible' });

    await pointerClick(primary, '#dexHumanToggle');
    await primary.waitForFunction(() => document.querySelector('#dexModePanel')?.dataset.humanInput === 'enabled');
    await primary.waitForFunction(() => globalThis.BrowserAiBridgeMachineHumanGate?.enabled?.() === true);

    const borrowed = await rawMutation(observer, port, {
      type: 'machine_create_space', requestId: 'viewer-borrow-attempt',
      roomId: 'room-viewer-one', name: 'Borrowed'
    });
    if (borrowed.code !== 'MACHINE_HUMAN_INPUT_LOCKED')
      throw new Error(`Observer borrowed primary authority: ${JSON.stringify(borrowed)}`);

    const copiedAuthorization = await primary.evaluate(() =>
      globalThis.BrowserAiBridgeMachineHumanGate.authorize({}).machineAuthorization);
    const copied = await rawMutation(observer, port, {
      type: 'machine_create_space', requestId: 'viewer-copied-token-attempt',
      roomId: 'room-viewer-one', name: 'Copied Token', machineAuthorization: copiedAuthorization
    });
    if (copied.code !== 'MACHINE_HUMAN_INPUT_HOLDER_MISMATCH')
      throw new Error(`Observer reused copied authority: ${JSON.stringify(copied)}`);

    await pointerClick(primary, '#dexMachineSpaces > summary');
    await primary.waitForFunction(() => {
      const button = document.querySelector('#machineCreateSpace');
      return !!button && button.disabled === false
        && !!globalThis.BrowserAiBridgeMachineSpacesUi;
    }, null, { timeout: 8000 });
    await primary.locator('#machineCreateSpace').scrollIntoViewIfNeeded();
    await pointerClick(primary, '#machineCreateSpace');
    await primary.locator('.machine-dialog-input').fill('Primary Authorized Space');
    await pointerClick(primary, '.machine-dialog-actions button:last-child');
    await primary.locator('#machineSpaceSelect option').filter({ hasText: 'Primary Authorized Space' })
      .waitFor({ state: 'attached', timeout: 8000 });

    const wrongRoom = await rawMutation(primary, port, {
      type: 'machine_create_space', requestId: 'wrong-room-attempt',
      roomId: 'room-viewer-two', name: 'Wrong Room'
    }, true);
    if (wrongRoom.code !== 'MACHINE_HUMAN_INPUT_SCOPE_MISMATCH')
      throw new Error(`Room scope was not enforced: ${JSON.stringify(wrongRoom)}`);

    const staleAuthorization = await primary.evaluate(() =>
      globalThis.BrowserAiBridgeMachineHumanGate.authorize({}).machineAuthorization);
    await pointerClick(primary, '#dexHumanToggle');
    await primary.waitForFunction(() => globalThis.BrowserAiBridgeMachineHumanGate?.enabled?.() === false);
    const revoked = await primary.evaluate(({ portValue, auth }) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${portValue}/ws`);
      const timer = setTimeout(() => reject(new Error('Revocation probe timed out.')), 6000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'ui',
        uiHolderId: globalThis.BrowserAiBridgeUiSocket?.uiHolderId })));
      ws.addEventListener('message', (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === 'server_session') ws.send(JSON.stringify({ type: 'machine_create_space',
          requestId: 'revoked-attempt', roomId: 'room-viewer-one', name: 'Revoked', machineAuthorization: auth }));
        if (payload.requestId === 'revoked-attempt') { clearTimeout(timer); ws.close(); resolve(payload); }
      });
    }), { portValue: port, auth: staleAuthorization });
    if (!['MACHINE_HUMAN_INPUT_LOCKED', 'DEX_HUMAN_LEASE_REVOKED'].includes(revoked.code))
      throw new Error(`Revoked authority remained usable: ${JSON.stringify(revoked)}`);
    if (errors.length) throw new Error(`Browser exceptions: ${errors.join(' | ')}`);

    console.log('MACHINE_HUMAN_GATE_PLAYWRIGHT_GREEN viewers=2 borrow=denied copiedToken=denied scope=exact revocation=immediate pointer=true');
  } catch (error) {
    console.error('MACHINE_HUMAN_GATE_PLAYWRIGHT_RED', error.stack || error.message);
    console.error('NEXUS_TAIL', tail.split(/\r?\n/).slice(-20).join('\n'));
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(() => { process.exitCode = 1; });
