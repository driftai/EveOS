'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');

async function pointerClick(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} must have pointer geometry`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

test('real pointer approval intercepts only the exact Human-Input-gated Playwright phrase', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <section id="dexModePanel" data-human-input="disabled"></section>
    <div id="dexRoomList"><button class="dex-room-item active" data-room-id="room-one">Room</button></div>
    <textarea id="dexPrompt"></textarea><button id="dexSend">Send to room</button>
    <pre id="dexDiagnostics"></pre>
    <script>
      window.__sent = []; window.__ordinaryClicks = 0; window.__sockets = [];
      class FakeSocket extends EventTarget {
        static OPEN = 1;
        constructor(url) { super(); this.url = url; this.readyState = FakeSocket.OPEN;
          window.__sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        send(value) { window.__sent.push(JSON.parse(value)); }
        close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
      }
      window.WebSocket = FakeSocket;
      document.querySelector('#dexSend').addEventListener('click', () => { window.__ordinaryClicks += 1; });
    </script>
  </body></html>`);
  await page.addScriptTag({ path: path.join(ROOT, 'public', 'machine-chat-approval-ui.js') });
  await page.waitForFunction(() => window.__sent.some((entry) => entry.type === 'hello'));

  await page.locator('#dexPrompt').fill('yes');
  await pointerClick(page, '#dexSend');
  assert.equal(await page.evaluate(() => window.__ordinaryClicks), 1);
  assert.equal(await page.evaluate(() => window.__sent.filter((entry) => entry.type === 'machine_chat_approve_supervised_job').length), 0);

  const phrase = '/approve-playwright machine-job-proof abcdef012345 A1B2C3D4E5F6';
  await page.locator('#dexPrompt').fill(phrase);
  await pointerClick(page, '#dexSend');
  assert.equal(await page.evaluate(() => window.__ordinaryClicks), 1, 'locked approval never reaches ordinary Dex send');
  assert.match(await page.locator('#dexDiagnostics').textContent(), /Enable Human Input/);

  await page.locator('#dexModePanel').evaluate((node) => { node.dataset.humanInput = 'enabled'; });
  await pointerClick(page, '#dexSend');
  const approval = await page.evaluate(() => window.__sent.find((entry) => entry.type === 'machine_chat_approve_supervised_job'));
  assert.equal(approval.roomId, 'room-one');
  assert.equal(approval.jobId, 'machine-job-proof');
  assert.equal(approval.commandDigestPrefix, 'abcdef012345');
  assert.equal(approval.challenge, 'A1B2C3D4E5F6');
  assert.equal(await page.locator('#dexPrompt').inputValue(), '');
  assert.equal(await page.evaluate(() => window.__ordinaryClicks), 1, 'approved phrase is consumed by the dedicated bridge');

  await page.evaluate((requestId) => {
    const payload = { type: 'machine_supervised_job_changed', requestId, action: 'started', job: { jobId: 'machine-job-proof' } };
    window.__sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }, approval.requestId);
  await page.waitForFunction(() => document.querySelector('#dexDiagnostics').textContent.includes('Approved and started'));
});
