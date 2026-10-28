#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const web = path.resolve(__dirname, '../../tools/Piano-Auto-Player/web');
const required = ['piano_controls.js', 'piano.js', 'piano_sound.js'];
for (const name of required) assert(fs.existsSync(path.join(web, name)), `Missing ${name}`);
const source = fs.readFileSync(path.join(web, 'piano_controls.js'), 'utf8');
assert(source.includes('eveos:piano:layout:v1'), 'Layout preference must use the dedicated key');
assert(source.includes('savePianoLayout(layoutSelect.value)'), 'Changes must save the selected layout');

const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<select id="pianoLayout"><option value="61">61-key</option><option value="88">88-key</option></select>
<select id="pianoSound"><option value="legacy_synth" selected>Legacy Synth</option></select>
<span id="pianoSoundStatus"></span><span id="pianoVisualMeta"></span>
<div id="practicePiano"></div>
<script type="module">
import { setupPianoControls } from '/assets/piano_controls.js';
const recorder = { setSound() {}, noteDownMidi() {}, noteUpMidi() {}, unlock() {}, prepareSound: async () => {} };
const preview = { setSound() {}, stop() {}, prepareSound: async () => {} };
setupPianoControls({
 layoutSelect: document.getElementById('pianoLayout'),
 soundSelect: document.getElementById('pianoSound'),
 soundStatus: document.getElementById('pianoSoundStatus'),
 visualMeta: document.getElementById('pianoVisualMeta'),
 piano: document.getElementById('practicePiano'),
 recorder, preview
});
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fixture);
    return;
  }
  const match = /^\/assets\/([a-zA-Z0-9_.-]+\.js)$/.exec(url.pathname);
  if (!match) { res.writeHead(404); res.end(); return; }
  const file = path.join(web, match[1]);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

async function check(browser, url, width) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  async function load() {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  }
  const state = () => page.evaluate(() => ({
    value: document.getElementById('pianoLayout').value,
    rendered: document.getElementById('practicePiano').dataset.layout,
    keys: document.querySelectorAll('#practicePiano [data-midi]').length,
    meta: document.getElementById('pianoVisualMeta').textContent,
    saved: localStorage.getItem('eveos:piano:layout:v1')
  }));
  const change = value => page.evaluate(value => {
    const select = document.getElementById('pianoLayout');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  try {
    await load();
    let s = await state();
    assert.equal(s.value, '61'); assert.equal(s.rendered, '61'); assert.equal(s.keys, 61);
    assert.equal(s.saved, null, 'Loading a default must not write a preference');
    await change('88');
    s = await state();
    assert.equal(s.value, '88'); assert.equal(s.rendered, '88'); assert.equal(s.keys, 88);
    assert.match(s.meta, /88-key A0/); assert.equal(s.saved, '88');
    await page.reload();
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
    s = await state();
    assert.equal(s.value, '88'); assert.equal(s.rendered, '88'); assert.equal(s.keys, 88);
    assert.match(s.meta, /88-key A0/); assert.equal(s.saved, '88');
    await change('61');
    await page.reload();
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
    s = await state();
    assert.equal(s.value, '61'); assert.equal(s.rendered, '61'); assert.equal(s.keys, 61);
    assert.equal(s.saved, '61');
    await page.evaluate(() => localStorage.setItem('eveos:piano:layout:v1', 'invalid'));
    await page.reload();
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
    s = await state();
    assert.equal(s.value, '61'); assert.equal(s.rendered, '61'); assert.equal(s.keys, 61);
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    console.log(`PIANO_LAYOUT_PERSISTENCE_BROWSER_OK viewport=${width} restore88=PASS restore61=PASS invalid=PASS`);
  } finally { await context.close(); }
}

async function checkBlockedStorage(browser, url) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('Storage denied'); };
    Storage.prototype.setItem = () => { throw new Error('Storage denied'); };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
    await page.evaluate(() => {
      const select = document.getElementById('pianoLayout');
      select.value = '88'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const mode = await page.locator('#practicePiano').getAttribute('data-layout');
    assert.equal(mode, '88', 'Storage failure must not block switching layout');
    assert.deepEqual(errors, [], 'No browser errors when storage is blocked');
    console.log('PIANO_LAYOUT_PERSISTENCE_STORAGE_DENIED_OK');
  } finally { await context.close(); }
}

(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/test`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1280, 480]) await check(browser, url, width);
    await checkBlockedStorage(browser, url);
    console.log('EVEOS_PIANO_LAYOUT_PREFERENCE_SMOKE_OK');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
