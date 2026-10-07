#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { launchChromiumOrConnect } = require('./playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'Nexus-Browser');
function reservePort() {
  return new Promise((resolve, reject) => {
    const lease = net.createServer();
    lease.once('error', reject);
    lease.listen(0, '127.0.0.1', () => {
      const port = lease.address().port;
      lease.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function waitHealth(port, child, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const probe = () => {
      if (child.exitCode != null) return reject(new Error(`Nexus child exited ${child.exitCode} before health.`));
      const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      });
      request.once('error', retry);
    };
    const retry = () => Date.now() - started > timeoutMs
      ? reject(new Error('Timed out waiting for disposable Nexus health.'))
      : setTimeout(probe, 100);
    probe();
  });
}
async function pointerClick(page, selector) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No pointer geometry for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function main() {
  const livePort = Number(process.env.NEXUS_BROWSER_LIVE_PORT || 0);
  const port = Number.isSafeInteger(livePort) && livePort > 0 ? livePort : await reservePort();
  const dataDir = livePort ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-machine-spaces-'));
  const logs = [];
  const child = livePort ? null : spawn(process.execPath, ['server.js'], { cwd: TOOL, windowsHide: true,
    env: { ...process.env, NEXUS_BROWSER_PORT: String(port), NEXUS_BROWSER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child?.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child?.stderr.on('data', (chunk) => logs.push(String(chunk)));
  let browser, page, createdTargetId = '';
  const pageErrors = [], frames = [];
  try {
    await waitHealth(port, child || { exitCode: null });
    ({ browser } = await launchChromiumOrConnect({ headless: true }));
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('websocket', (websocket) => websocket.on('framesent', (event) => frames.push(String(event.payload))));
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#targetClassSelect option[value="terminal-origin"]').waitFor({ state: 'attached' });
    await page.selectOption('#targetClassSelect', 'terminal-origin');
    await page.locator('#terminalTargetControls').waitFor({ state: 'visible' });
    assertText(await page.locator('#terminalTargetStatus').textContent(), 'Create a Nexus-managed terminal');
    if (process.platform === 'win32') {
      await page.selectOption('#terminalTypeSelect', 'cmd');
      await page.fill('#terminalCwd', ROOT);
      const sessionLabel = livePort ? `Nexus Live Proof ${Date.now()}` : 'Managed Command Prompt';
      if (livePort) await page.fill('#terminalLabel', sessionLabel);
      await pointerClick(page, '#createTerminalTarget');
      const createdOption = page.locator('#terminalTargetSelect option').filter({ hasText: sessionLabel });
      await createdOption.waitFor({ state: 'attached' });
      createdTargetId = await createdOption.getAttribute('value');
      if (!createdTargetId) throw new Error('Created terminal did not expose a stable target ID.');
      await page.selectOption('#terminalTargetSelect', createdTargetId);
      await page.fill('#prompt', 'echo NEXUS_MACHINE_SPACES_BROWSER_OK');
      const mode = await page.evaluate(async () => ({ dom: document.getElementById('targetClassSelect').value,
        app: typeof state === 'object' ? state.selectedTargetClassId : 'unavailable',
        api: !!globalThis.BrowserAiBridgeMachineSpacesUi }));
      if (mode.dom !== 'terminal-origin' || mode.app !== 'terminal-origin' || !mode.api)
        throw new Error(`Terminal mode diverged: ${JSON.stringify(mode)}`);
      await pointerClick(page, '#sendPrompt');
      await page.locator('.machine-dialog').getByText('Base Mode terminal command', { exact: false }).waitFor();
      await pointerClick(page, '.machine-dialog-actions button:last-child');
      await page.locator('#transcript').getByText('NEXUS_MACHINE_SPACES_BROWSER_OK', { exact: false }).last().waitFor({ timeout: 10000 });

      if (!livePort) {
        await pointerClick(page, '#dexModeTab');
        await pointerClick(page, '#dexHumanToggle');
        await pointerClick(page, '#machineCreateSpace');
        await page.locator('.machine-dialog-input').fill('Browser Proof');
        await pointerClick(page, '.machine-dialog-actions button:last-child');
        await page.locator('#machineSpaceSelect option').filter({ hasText: 'Browser Proof' }).waitFor({ state: 'attached' });
        await pointerClick(page, '#machineAttach');
        await page.locator('#machineSpaceResources').getByText('Managed Command Prompt', { exact: false }).waitFor();
      }
    }
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join(' | ')}`);
    console.log(`NEXUS_MACHINE_SPACES_BROWSER_SMOKE_OK native=${process.platform === 'win32' ? 'cmd' : 'ui-only'} mode=${livePort ? 'live' : 'isolated'}`);
  } catch (error) {
    const ui = page ? await page.locator('body').innerText().catch(() => '') : '';
    const debug = page ? await page.evaluate(() => ({ targetClass: document.getElementById('targetClassSelect')?.value,
      sendDisabled: document.getElementById('sendPrompt')?.disabled,
      machineApi: !!globalThis.BrowserAiBridgeMachineSpacesUi })).catch(() => null) : null;
    throw new Error(`${error.message}\nDebug: ${JSON.stringify(debug)}\nSent frames:\n${frames.slice(-12).join('\n')}\nPage errors: ${pageErrors.join(' | ') || 'none'}\nUI tail:\n${ui.split(/\r?\n/).filter(Boolean).slice(-35).join('\n')}\nNexus tail:\n${logs.join('').split(/\r?\n/).filter(Boolean).slice(-20).join('\n')}`);
  } finally {
    if (livePort && page && createdTargetId) {
      try {
        await page.selectOption('#targetClassSelect', 'terminal-origin');
        await page.selectOption('#terminalTargetSelect', createdTargetId);
        await pointerClick(page, '#stopTerminalTarget');
        await page.locator('.machine-dialog').getByText('Stop', { exact: false }).waitFor();
        await pointerClick(page, '.machine-dialog-actions button:last-child');
        await page.locator(`#terminalTargetSelect option[value="${createdTargetId}"]`).waitFor({ state: 'detached' });
      } catch (error) { logs.push(`Live cleanup warning: ${error.message}`); }
    }
    await browser?.close().catch(() => {});
    if (child && child.exitCode == null) child.kill();
    if (child) await new Promise((resolve) => child.exitCode != null ? resolve() : child.once('exit', resolve));
    if (dataDir && path.dirname(dataDir) === os.tmpdir() && path.basename(dataDir).startsWith('eveos-machine-spaces-'))
      fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
function assertText(actual, expected) {
  if (!String(actual || '').includes(expected)) throw new Error(`Expected ${JSON.stringify(expected)} in ${JSON.stringify(actual)}`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
