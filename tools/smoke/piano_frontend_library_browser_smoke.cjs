#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(repo, p), 'utf8');
const ui = read('js/modules/features/audioflix/audioflix.piano.ui.js');
const views = read('js/modules/features/audioflix/audioflix.piano.views.js');
const frontend = read('js/modules/features/audioflix/audioflix.piano.frontend.js');
const css = read('js/modules/features/audioflix/audioflix.piano.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.css');
const port = read('tools/Piano-Auto-Player/web/piano_frontend_port.js');
const app = read('tools/Piano-Auto-Player/web/app.js');
assert(app.includes('setupPianoFrontendPort({ api, play:'), 'real player must install the bridge');
assert(app.includes('return sheetWorkspace.load('), 'front-end song loading must await existing workspace');

const childHtml = `<!doctype html><html><body><script type="module">
import { setupPianoFrontendPort } from '/port.js';
window.__calls = [];
window.__songs = [
  { id: 'one', title: 'Moonlight', artist: 'Composer', sheet: 'abc' },
  { id: 'two', title: 'Danger <img src=x onerror=alert(1)>', performance: [{key:'a'}] }
];
setupPianoFrontendPort({
 api: { songs: async () => ({ songs: window.__songs }) },
 play: async song => { window.__calls.push(['play',song.id]); window.__state = 'playing'; },
 pause: async () => { window.__calls.push(['pause']); window.__state = 'paused'; },
 stop: async () => { window.__calls.push(['stop']); window.__state = 'idle'; },
 status: () => ({status: window.__state || 'idle'})
});
window.__keep = 1147;
</script></body></html>`;

async function test(browser, width) {
 const page = await browser.newPage({ viewport: { width, height: 860 } });
 await page.route('**/*', route => {
   const url = route.request().url();
   if (url === 'http://127.0.0.1:8765/test') return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="test-root"></main></body></html>'});
   if (url === 'http://127.0.0.1:8771/piano') return route.fulfill({status:200,contentType:'text/html',body:childHtml});
   if (url === 'http://127.0.0.1:8771/port.js') return route.fulfill({status:200,contentType:'application/javascript',body:port});
   return route.abort();
 });
 try {
  await page.goto('http://127.0.0.1:8765/test');
  await page.addStyleTag({content:css});
  await page.addScriptTag({content:views});
  await page.addScriptTag({content:frontend});
  await page.addScriptTag({content:ui});
  await page.evaluate(() => {
    window.EveAudioflixPiano = {state:{running:true, installed:true, phase:'running', url:'http://127.0.0.1:8771/piano', message:'Piano online'}, serviceUrl: ()=>'http://127.0.0.1:8771/piano', refresh:async()=>{}};
    window.EveAudioflixState = {getSnapshot:()=>({})};
    const root=document.querySelector('#test-root');root.innerHTML=window.EveAudioflixPianoUi.render();
    root.addEventListener('click',e=>{const b=e.target.closest('[data-af-action]');if(b)void window.EveAudioflixPianoUi.handleAction(b);});
    window.EveAudioflixPianoUi.afterRender(root);
    window.__iframe=root.querySelector('[data-piano-frame]');
  });
  await page.waitForFunction(()=>document.querySelector('[data-piano-frame]')?.getAttribute('src')==='http://127.0.0.1:8771/piano');
  let child = null;
  for (let attempt = 0; attempt < 80 && !child; attempt++) {
    child = page.frame({url:'http://127.0.0.1:8771/piano'});
    if (!child) await page.waitForTimeout(50);
  }
  assert(child,'Piano iframe must exist');
  await child.waitForFunction(()=>window.__keep===1147);
  await page.click('[data-piano-view-switch]');
  await page.waitForSelector('.piano-frontend-song-play');
  const songs=await page.locator('.piano-frontend-song-info strong').allTextContents();
  assert.equal(songs.length,2);
  assert(songs[0].includes('Moonlight'));
  assert.equal(await page.locator('.piano-frontend-song-info img').count(),0,'titles must not be parsed as HTML');
  assert.equal(await page.locator('[data-piano-frontend] [data-pf-count]').textContent(),'2 songs');
  await page.locator('[data-af-action="piano-frontend-play"][data-song-id="one"]').click();
  await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='play'&&x[1]==='one'));
  await page.waitForFunction(()=>document.querySelector('[data-pf-message]')?.textContent?.includes('Song sent'));
  await page.click('[data-af-action="piano-frontend-pause"]');
  await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='pause'));
  await page.click('[data-af-action="piano-frontend-stop"]');
  await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='stop'));
  await page.locator('[data-pf-search]').fill('Moon');
  assert.equal(await page.locator('.piano-frontend-song').count(),1,'search must filter songs without mutating server data');
  await page.locator('[data-pf-search]').fill('');
  await child.evaluate(()=>window.__songs.push({id:'three',title:'Third Song'}));
  await page.click('[data-af-action="piano-frontend-refresh"]');
  await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===3);
  await page.click('[data-piano-view-switch]');
  await page.click('[data-piano-view-switch]');
  const stable=await page.evaluate(()=>({same:document.querySelector('[data-piano-frame]')===window.__iframe,view:document.querySelector('[data-audioflix-piano]').dataset.pianoView,source:document.querySelector('[data-piano-frame]').getAttribute('src')}));
  assert(stable.same && stable.view==='frontend','backend document must be preserved on view change');
  assert.equal(await child.evaluate(()=>window.__keep),1147);
  await page.evaluate(()=>{window.EveAudioflixPiano.state.running=false;window.EveAudioflixPiano.state.phase='stopped';window.EveAudioflixPiano.state.url='';window.dispatchEvent(new Event('eve:audioflix-piano-status'));});
  await page.waitForFunction(()=>document.querySelector('[data-pf-playback]')?.textContent==='Piano offline');
  assert.equal(await page.locator('.piano-frontend-song').count(),0,'do not show stale playable entries when service stops');
  console.log(`PIANO_FRONTEND_LIBRARY_BROWSER_OK viewport=${width} songs=PASS play=PASS pause=PASS stop=PASS search=PASS refresh=PASS iframe-preserved=PASS offline=PASS`);
 } finally { await page.close(); }
}
(async()=>{const browser=await chromium.launch({headless:true});try{for(const width of [1440,760,480])await test(browser,width);console.log('EVEOS_PIANO_FRONTEND_LIBRARY_BROWSER_PASS');}finally{await browser.close();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
