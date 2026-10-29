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
const soundSource = fs.readFileSync(path.join(web, 'piano_sound.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
assert(source.includes('eveos:piano:layout:v1'), 'Layout preference must use the dedicated key');
assert(source.includes('savePianoLayout(layoutSelect.value)'), 'Changes must save the selected layout');
for (const [id, preset] of [
  ['fluid_studio_grand', '0000_FluidR3_GM_sf2_file'],
  ['fluid_electric_piano_1', '0040_FluidR3_GM_sf2_file'],
  ['fluid_electric_piano_2', '0050_FluidR3_GM_sf2_file']
]) {
  assert(soundSource.includes(`${preset}.js`), `${id} must use its FluidR3 preset`);
  assert(soundSource.includes(`_tone_${preset}`), `${id} must bind the matching preset variable`);
  assert(indexSource.includes(`value="${id}"`), `${id} must be selectable in Internal Play`);
}
const recommendedOrder = [
  'fluid_studio_grand', 'acoustic_grand', 'bright_acoustic',
  'fluid_electric_piano_1', 'fluid_electric_piano_2',
  'electric_grand', 'honky_tonk', 'legacy_synth'
];
let catalogCursor = -1;
let selectorCursor = -1;
for (const id of recommendedOrder) {
  const nextCatalog = soundSource.indexOf(`  ${id}:`);
  const nextSelector = indexSource.indexOf(`value="${id}"`);
  assert(nextCatalog > catalogCursor, `${id} must keep the recommended catalog order`);
  assert(nextSelector > selectorCursor, `${id} must keep the recommended selector order`);
  catalogCursor = nextCatalog;
  selectorCursor = nextSelector;
}
assert(indexSource.includes('value="acoustic_grand" selected'),
  'Recommended ordering must not force the larger FluidR3 bank to preload by default');

const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<select id="pianoLayout"><option value="61">61-key</option><option value="88">88-key</option></select>
<select id="pianoSound"><option value="legacy_synth" selected>Legacy Synth</option></select>
<span id="pianoSoundStatus"></span><span id="pianoVisualMeta"></span>
<div id="practicePiano"></div>
<div id="backgroundPreview"></div>
<script type="module">
import { setupPianoControls } from '/assets/piano_controls.js';
import { InternalPreviewPlayer } from '/assets/internal_preview.js';
window.__previewStops = 0;
const recorder = { setSound() {}, noteDownMidi() {}, noteUpMidi() {}, unlock() {}, prepareSound: async () => {} };
const preview = { setSound() {}, stop() { window.__previewStops += 1; }, prepareSound: async () => {} };
setupPianoControls({
 layoutSelect: document.getElementById('pianoLayout'),
 soundSelect: document.getElementById('pianoSound'),
 soundStatus: document.getElementById('pianoSoundStatus'),
 visualMeta: document.getElementById('pianoVisualMeta'),
 piano: document.getElementById('practicePiano'),
 recorder, preview
});
window.__runBackgroundProof = () => {
 const scheduled = [];
 const output = {
   unlock: async () => {}, setSound() {}, prepareSound: async () => true,
   soundLabel: () => 'Fixture', allOff() {}, audioTime: () => 100,
   scheduleMidi: (midi, id, at, duration) => scheduled.push({ midi, id, at, duration }),
   scheduleToken() {}, highlightMidi() {}, unhighlightMidi() {},
   highlightToken() {}, unhighlightToken() {}
 };
 const player = new InternalPreviewPlayer(document.getElementById('backgroundPreview'), output);
 player._isBackgrounded = () => false;
 player.start({ duration_ms: 16000, total_events: 3, events: [
   { event_index: 1, at_ms: 1000, duration_ms: 80, midi_notes: [60] },
   { event_index: 2, at_ms: 5000, duration_ms: 80, midi_notes: [62] },
   { event_index: 3, at_ms: 15000, duration_ms: 80, midi_notes: [64] }
 ] }, 1, 0);
 const foreground = scheduled.length;
 window.dispatchEvent(new Event('blur'));
 const background = scheduled.length;
 window.dispatchEvent(new Event('blur'));
 const deduplicated = scheduled.length;
 player.stop();
 return { foreground, background, deduplicated, scheduled };
};
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
    saved: localStorage.getItem('eveos:piano:layout:v1'),
    previewStops: window.__previewStops
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
    assert.equal(s.previewStops, 0, 'Layout changes must not stop active playback');
    const background = await page.evaluate(() => window.__runBackgroundProof());
    assert.equal(background.foreground, 2, 'Foreground scheduling stays bounded to the lookahead window');
    assert.equal(background.background, 3, 'Blur schedules the full remaining timeline on the audio clock');
    assert.equal(background.deduplicated, 3, 'Repeated background signals must not duplicate scheduled notes');
    assert.equal(new Set(background.scheduled.map(row => row.id)).size, 3, 'Scheduled notes use unique identities');
    assert.ok(background.scheduled[2].at - background.scheduled[1].at > 9,
      'Background notes retain their original audio-clock spacing');
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
    console.log(`PIANO_LAYOUT_PERSISTENCE_BROWSER_OK viewport=${width} restore88=PASS restore61=PASS playbackPreserved=PASS invalid=PASS`);
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
