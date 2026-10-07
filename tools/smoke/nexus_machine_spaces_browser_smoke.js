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
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-machine-spaces-'));
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], { cwd: TOOL, windowsHide: true,
    env: { ...process.env, NEXUS_BROWSER_PORT: String(port), NEXUS_BROWSER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  let browser, page;
  const pageErrors = [], frames = [];
  try {
    await waitHealth(port, child);
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
      await pointerClick(page, '#createTerminalTarget');
      await page.locator('#terminalTargetSelect option').filter({ hasText: 'Managed Command Prompt' }).waitFor({ state: 'attached' });
      await page.fill('#prompt', 'echo NEXUS_MACHINE_SPACES_BROWSER_OK');
      const mode = await page.evaluate(async () => ({ dom: document.getElementById('targetClassSelect').value,
        app: typeof state === 'object' ? state.selectedTargetClassId : 'unavailable',
        api: !!globalThis.BrowserAiBridgeMachineSpacesUi }));
      if (mode.dom !== 'terminal-origin' || mode.app !== 'terminal-origin' || !mode.api)
        throw new Error(`Terminal mode diverged: ${JSON.stringify(mode)}`);
      page.once('dialog', (dialog) => dialog.accept());
      await pointerClick(page, '#sendPrompt');
      await page.locator('#transcript').getByText('NEXUS_MACHINE_SPACES_BROWSER_OK', { exact: false }).last().waitFor({ timeout: 10000 });

      await pointerClick(page, '#dexModeTab');
      await pointerClick(page, '#dexHumanToggle');
      page.once('dialog', (dialog) => dialog.accept('Browser Proof'));
      await pointerClick(page, '#machineCreateSpace');
      await page.locator('#machineSpaceSelect option').filter({ hasText: 'Browser Proof' }).waitFor({ state: 'attached' });
      page.once('dialog', (dialog) => dialog.accept());
      await pointerClick(page, '#machineAttach');
      await page.locator('#machineSpaceResources').getByText('Managed Command Prompt', { exact: false }).waitFor();
    }
    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join(' | ')}`);
    console.log(`NEXUS_MACHINE_SPACES_BROWSER_SMOKE_OK native=${process.platform === 'win32' ? 'cmd' : 'ui-only'}`);
  } catch (error) {
    const ui = page ? await page.locator('body').innerText().catch(() => '') : '';
    const debug = page ? await page.evaluate(() => ({ targetClass: document.getElementById('targetClassSelect')?.value,
      sendDisabled: document.getElementById('sendPrompt')?.disabled,
      machineApi: !!globalThis.BrowserAiBridgeMachineSpacesUi })).catch(() => null) : null;
    throw new Error(`${error.message}\nDebug: ${JSON.stringify(debug)}\nSent frames:\n${frames.slice(-12).join('\n')}\nPage errors: ${pageErrors.join(' | ') || 'none'}\nUI tail:\n${ui.split(/\r?\n/).filter(Boolean).slice(-35).join('\n')}\nNexus tail:\n${logs.join('').split(/\r?\n/).filter(Boolean).slice(-20).join('\n')}`);
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode == null) child.kill();
    await new Promise((resolve) => child.exitCode != null ? resolve() : child.once('exit', resolve));
    if (path.dirname(dataDir) === os.tmpdir() && path.basename(dataDir).startsWith('eveos-machine-spaces-'))
      fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
function assertText(actual, expected) {
  if (!String(actual || '').includes(expected)) throw new Error(`Expected ${JSON.stringify(expected)} in ${JSON.stringify(actual)}`);
}
main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
