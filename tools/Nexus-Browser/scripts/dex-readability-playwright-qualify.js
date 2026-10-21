'use strict';
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
function fail(message) { throw new Error(message); }

async function main() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><main><div id="rooms"></div><div id="transcript"></div></main>');
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.goto(origin);
    await page.addStyleTag({ path: path.join(root, 'public', 'dex-mode.css') });
    await page.addScriptTag({ path: path.join(root, 'public', 'dex-receipt-presentation.js') });
    await page.addScriptTag({ path: path.join(root, 'public', 'dex-room-view.js') });
    await page.evaluate(() => {
      const room = { id: 'room-readable', name: 'Release Repair', members: [{ id: 'agent-tlo', name: 'TLO' }], messages: [
        { id: 'success', senderKind: 'system', senderName: 'Machine Spaces', text: 'raw success receipt',
          engineeringIncident: { jobId: 'machine-job-exact', requestId: 'request-exact', roomId: 'room-readable',
            spaceId: 'space-exact', targetId: 'terminal-exact', outputId: 'output-exact', state: 'completed',
            classification: 'completed', exitCode: 0 },
          engineeringVerification: { state: 'completed', exitCode: 0, outcome: 'GREEN', receipt: 'data/runtime/receipt.json' } },
        { id: 'queued', senderKind: 'system', senderName: 'Dex', text: 'raw queued receipt',
          controlReceipt: { requestId: 'prepare-exact', roomId: 'room-readable', action: 'governor_prepare', ok: true } },
        { id: 'failure', senderKind: 'system', senderName: 'Dex', text: 'transport failed', relayFailure: true,
          sourceMessageId: 'source-exact', turnRequestId: 'turn-exact' }
      ] };
      const state = { rooms: [room], activeRoomId: room.id };
      const list = document.getElementById('rooms'), transcript = document.getElementById('transcript');
      transcript.scrollTop = 0;
      Object.defineProperties(transcript, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
      const view = globalThis.BrowserAiBridgeDexRoomView.createView({ state,
        el: { dexRoomList: list, dexTranscript: transcript },
        protocol: { messageWrapper: (message) => message.text }, onRoomSelect() {} });
      view.renderRooms(); view.renderTranscript(room);
    });
    const cards = page.locator('.dex-message');
    if (await cards.count() !== 3) fail('Expected three rendered semantic notifications.');
    if (!await cards.nth(0).getByText('Verified success', { exact: true }).isVisible()) fail('Verified success label is not visible.');
    if (!await cards.nth(1).getByText('Prepared', { exact: true }).isVisible()) fail('Prepared label is not visible.');
    if (!await cards.nth(2).getByText('Delivery failure', { exact: true }).isVisible()) fail('Failure label is not visible.');
    if (!await cards.nth(0).getByText('Publication', { exact: true }).isVisible()) fail('Human-readable result stages are missing.');
    if (!await cards.nth(0).locator('details').isVisible()) fail('Technical details disclosure is missing.');
    await cards.nth(0).locator('details').evaluate((node) => { node.open = true; });
    await cards.nth(0).getByRole('button', { name: 'Copy technical IDs' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (!copied.includes('machine-job-exact') || !copied.includes('terminal-exact')) fail('Canonical IDs were not copied.');
    const tones = await cards.evaluateAll((nodes) => nodes.map((node) => node.className));
    if (!tones[0].includes('engineering-success') || !tones[1].includes('engineering-warning')
        || !tones[2].includes('engineering-danger')) fail('Semantic notification tones are incorrect.');
    console.log('DEX_READABILITY_PLAYWRIGHT_OK cards=3 labels=true details=true copy=true tones=true');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(`DEX_READABILITY_PLAYWRIGHT_FAIL ${error.message}`); process.exitCode = 1; });
