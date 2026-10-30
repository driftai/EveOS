#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { opaqueRealAppTest } = require('./lib/piano_frontend_library_real_app.cjs');
const repo = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(repo, p), 'utf8');
const ui = read('js/modules/features/audioflix/audioflix.piano.ui.js');
const views = read('js/modules/features/audioflix/audioflix.piano.views.js');
const frontend = read('js/modules/features/audioflix/audioflix.piano.frontend.js');
const presentationPorts = read('js/modules/features/audioflix/audioflix.piano.frontend.ports.js');
const mediaFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.media.js');
const organizeFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.organize.js');
const settingsFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.settings.js');
const extendedPort = read('tools/Piano-Auto-Player/web/piano_frontend_extended_port.js');
const frontendAppBridge = read('tools/Piano-Auto-Player/web/piano_frontend_app_bridge.js');
const css = read('js/modules/features/audioflix/audioflix.piano.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.ports.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.media.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.organize.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.settings.css');
const port = read('tools/Piano-Auto-Player/web/piano_frontend_port.js');
const app = read('tools/Piano-Auto-Player/web/app.js');
assert(app.includes('setupPianoFrontendAppBridge({'), 'real player must install the frontend app bridge');
assert(app.lastIndexOf('setupPianoFrontendAppBridge({') < app.lastIndexOf('bind(); updateInputModeUI()'), 'bridge must install before nonessential Piano UI boot calls');
assert(app.includes('return sheetWorkspace.load('), 'front-end song loading must await existing workspace');
assert(port.includes("const replyTarget = parentOrigin || '*'"), 'opaque EveOS parents must have a safe reply path');
assert(port.includes('window.__eveosPianoFrontendPortReady = true'), 'real Piano page must expose bridge-install evidence');
assert(port.includes('pulseReady();'), 'bridge must briefly reannounce readiness during startup');
assert(port.includes('event.source !== parent'), 'bridge must pin commands to the actual embedding parent');
assert(port.includes("data?.type === 'eveos:audioflix-context'"), 'bridge must reannounce after host context');
assert(frontend.includes("directJson('/api/songs')"), 'frontend must have direct library fallback');
assert(frontend.includes('if (!bridgeReady) applyLibrary'), 'direct fallback must not overwrite bridge-owned library');
assert(css.includes('> .audioflix-piano-header { display: none; }'), 'frontend must keep technical lifecycle controls in Backend');
assert(!presentationPorts.includes('Backend Player Queue'), 'frontend copy must not expose Backend wiring');
assert(frontendAppBridge.includes('eveos:piano:internal-play:v1'), 'Internal Play must have a durable Backend preference');
assert(frontendAppBridge.includes('eveos:piano:target-window:v1'), 'Target Window must have a durable Backend preference');
assert(organizeFrontend.includes("ports.command?.('song:update'"), 'Piano organization must use the Backend song owner');
assert(mediaFrontend.includes("ports.command?.('song:update'"), 'listener metadata must use the shared Backend port');
assert(mediaFrontend.includes("ports.command?.('progress:seek'"), 'listener seek must use the existing Backend progress owner');
assert(settingsFrontend.includes("ports.command?.('queue:reorder'"), 'Piano Internal View must reorder the shared Backend queue');
assert(organizeFrontend.includes("ports.command?.('queue:add-many'"), 'filtered group queueing must use one Backend queue command');

const childHtml = `<!doctype html><html><body><script type="module">
import { setupPianoFrontendPort } from '/port.js';
window.__calls = [];
window.__songs = [
  { id: 'one', title: 'Moonlight', artist: 'Composer', sheet: 'abc', source_url:'https://example.test/shared', identifiers:{custom:{piano_group:'Study',piano_playback_v1:{route:'internal',layout:'88'}}}, updated_at: 100 },
  { id: 'two', title: 'Danger <img src=x onerror=alert(1)>', source_url:'https://example.test/shared', identifiers:{custom:{piano_group:'Concert',piano_playback_v1:{route:'target'}}}, performance: [{key:'a'}], updated_at: 200 }
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

function installHost(page, serviceUrl) {
  return page.evaluate(url => {
    window.EveAudioflixPiano = {state:{running:true, installed:true, phase:'running', url, message:'Piano online'}, serviceUrl: ()=>url, refresh:async()=>{}};
    window.EveAudioflixState = {getSnapshot:()=>({})};
    const root=document.querySelector('#test-root');root.innerHTML=window.EveAudioflixPianoUi.render();
    root.addEventListener('click',e=>{const b=e.target.closest('[data-af-action]');if(b)void window.EveAudioflixPianoUi.handleAction(b);});
    window.EveAudioflixPianoUi.afterRender(root);
    window.__iframe=root.querySelector('[data-piano-frame]');
  }, serviceUrl);
}

async function syntheticTest(browser, width) {
 const page = await browser.newPage({ viewport: { width, height: 860 } });
 await page.route('**/*', route => {
   const url = route.request().url();
   if (url === 'http://127.0.0.1:8765/test') return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="test-root"></main></body></html>'});
   if (url === 'http://127.0.0.1:8771/piano') return route.fulfill({status:200,contentType:'text/html',body:childHtml});
   if (url === 'http://127.0.0.1:8771/port.js') return route.fulfill({status:200,contentType:'application/javascript',body:port});
   if (url === 'http://127.0.0.1:8771/piano_frontend_extended_port.js') return route.fulfill({status:200,contentType:'application/javascript',body:extendedPort});
   if (url === 'http://127.0.0.1:8771/api/songs') return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'http://127.0.0.1:8765'},body:JSON.stringify({songs:[{id:'one',title:'Moonlight',artist:'Composer',updated_at:100},{id:'two',title:'Danger <img src=x onerror=alert(1)>',performance:[{key:'a'}],updated_at:200}]})});
   if (url === 'http://127.0.0.1:8771/api/status') return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'http://127.0.0.1:8765'},body:JSON.stringify({status:'idle'})});
   return route.abort();
 });
 try {
  await page.goto('http://127.0.0.1:8765/test');
  await page.addStyleTag({content:css});
  await page.addScriptTag({content:views});
  await page.addScriptTag({content:frontend});
  await page.addScriptTag({content:presentationPorts});
  await page.addScriptTag({content:mediaFrontend});
  await page.addScriptTag({content:organizeFrontend});
  await page.addScriptTag({content:settingsFrontend});
  await page.addScriptTag({content:ui});
  await installHost(page, 'http://127.0.0.1:8771/piano');
  let child = null;
  for (let attempt = 0; attempt < 80 && !child; attempt++) { child = page.frame({url:'http://127.0.0.1:8771/piano'}); if (!child) await page.waitForTimeout(50); }
  assert(child,'Piano iframe must exist');
  await child.waitForFunction(()=>window.__keep===1147);
  await page.click('[data-piano-view-switch]');
  await page.waitForSelector('.piano-frontend-song-play');
  await page.waitForFunction(()=>document.querySelector('[data-pf-playback]')?.textContent !== 'Connecting…');
  assert(await page.locator('.piano-frontend-transport [data-af-action=\"piano-frontend-pause\"]').isEnabled(),'bridge must recover even if the first ready signal races host setup');
  const songs=await page.locator('.piano-frontend-song-info strong').allTextContents();
  assert.equal(songs.length,2); assert(songs.includes('Moonlight'));
  assert.equal(await page.locator('.piano-frontend-song-info img').count(),0,'titles must not be parsed as HTML');
  assert.equal(await page.locator('[data-pf-count]').textContent(),'2 songs');
  assert.equal(await page.locator('.audioflix-piano-header').evaluate(el=>getComputedStyle(el).display),'none','technical Piano Automation toolbar must stay in Backend');
  assert.equal(await page.locator('.piano-frontend-title h2').textContent(),'Piano Auto Player - Frontend');
  assert.equal(await page.locator('[data-piano-view-title]').textContent(),'Piano Library');
  if (width === 1440) {
   assert.equal(await page.locator('[data-pfs-settings-button]').count(),2,'Music-style Piano cards expose song settings');
   await page.locator('.piano-frontend-song[data-song-id="one"] [data-pfs-settings-button]').click();
   assert.equal(await page.locator('[data-pfs-route]').inputValue(),'internal','card settings project the Backend-owned playback override');
   assert((await page.locator('[data-pfs-duplicates] > div').count())>=1,'exact source matches are shown as non-destructive duplicate suggestions');
   await page.locator('[data-pfs-action="close"]').click();
   await page.locator('[data-pfo-action="groups"]').click();
   await page.locator('[data-pfo-route-filter]').selectOption('internal');
   assert.equal(await page.locator('.piano-frontend-song').count(),1,'route filters operate over the shared Backend library');
   await page.locator('[data-pfo-route-filter]').selectOption('all');
  }
  assert(await page.locator('[data-af-action="piano-frontend-stop"]').isEnabled(),'stop must enable after bridge handshake');
  await page.locator('[data-af-action="piano-frontend-play"][data-song-id="one"]').click();
  await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='play'&&x[1]==='one'));
  await page.waitForFunction(()=>document.querySelector('[data-pf-message]')?.textContent?.includes('Song sent'));
  await page.click('.piano-frontend-transport [data-af-action="piano-frontend-pause"]'); await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='pause'));
  await page.click('[data-af-action="piano-frontend-stop"]'); await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='stop'));
  await page.locator('[data-pfo-action="nexus"]').click(); await page.locator('[data-pfo-search]').fill('Moon'); await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===1); assert.equal(await page.locator('.piano-frontend-song').count(),1);
  await page.locator('[data-pfo-search]').fill('');
  await page.locator('[data-pf-sort]').selectOption('az');
  assert.equal((await page.locator('.piano-frontend-song-info strong').allTextContents())[0].startsWith('Danger'),true,'A-Z sort must work');
  await child.evaluate(()=>window.__songs.push({id:'three',title:'Third Song',updated_at:300}));
  await page.click('[data-af-action="piano-frontend-refresh"]');
  await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===3);
  await page.click('[data-piano-view-switch]'); await page.click('[data-piano-view-switch]');
  const stable=await page.evaluate(()=>({same:document.querySelector('[data-piano-frame]')===window.__iframe,view:document.querySelector('[data-audioflix-piano]').dataset.pianoView}));
  assert(stable.same && stable.view==='frontend','backend document must be preserved on view change');
  assert.equal(await page.locator('[data-piano-view-title]').textContent(),'Piano Library');
  assert.equal(await child.evaluate(()=>window.__keep),1147);
  await page.click('[data-piano-view-switch]');
  await child.evaluate(()=>window.__songs.push({id:'four',title:'Backend Refresh Song',updated_at:400}));
  await page.click('[data-af-action="piano-refresh"]');
  await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===4);
  assert.equal(await page.locator('[data-piano-frontend]').isHidden(),true,'Backend Refresh must update the shared Frontend while that view remains hidden');
  await page.click('[data-piano-view-switch]');
  assert((await page.locator('.piano-frontend-song-info strong').allTextContents()).includes('Backend Refresh Song'),'Backend Refresh must invalidate and update the shared Frontend library');
  await page.evaluate(()=>{window.EveAudioflixPiano.state.running=false;window.EveAudioflixPiano.state.phase='stopped';window.EveAudioflixPiano.state.url='';window.dispatchEvent(new Event('eve:audioflix-piano-status'));});
  await page.waitForFunction(()=>document.querySelector('[data-pf-playback]')?.textContent==='Piano offline');
  assert.equal(await page.locator('.piano-frontend-song').count(),0,'do not show stale playable entries when service stops');
  assert.equal(await page.locator('[data-pf-service-start]').isVisible(),true,'frontend must offer a friendly service start action when offline');
  await page.evaluate(()=>{window.EveAudioflixPiano.start=async()=>{window.__frontStartRequested=true;};});
  await page.locator('[data-pf-service-start]').click();
  assert.equal(await page.evaluate(()=>window.__frontStartRequested===true),true,'frontend start action must use the existing lifecycle owner');
  console.log(`PIANO_FRONTEND_LIBRARY_BROWSER_OK viewport=${width} songs=PASS controls=PASS sort=PASS play=PASS shared-refresh=PASS iframe-preserved=PASS offline=PASS`);
 } finally { await page.close(); }
}

(async()=>{const browser=await chromium.launch({headless:true});try{await opaqueRealAppTest(browser,{repo,css,views,frontend,presentationPorts,mediaFrontend,organizeFrontend,settingsFrontend,ui,installHost});for(const width of [1440,760,480])await syntheticTest(browser,width);console.log('EVEOS_PIANO_FRONTEND_LIBRARY_BROWSER_PASS');}finally{await browser.close();}})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
