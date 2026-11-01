#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { opaqueRealAppTest } = require('./lib/piano_frontend_library_real_app.cjs');
const { testPianoRetention } = require('./lib/piano_frontend_retention_browser.cjs');
const repo = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(repo, p), 'utf8');
const ui = read('js/modules/features/audioflix/audioflix.piano.ui.js');
const views = read('js/modules/features/audioflix/audioflix.piano.views.js');
const frontend = read('js/modules/features/audioflix/audioflix.piano.frontend.js');
const retentionSource = read('js/modules/features/audioflix/audioflix.ui.piano-retain.js');
const presentationPorts = read('js/modules/features/audioflix/audioflix.piano.frontend.ports.js');
const mediaFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.media.js');
const taxonomyFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.taxonomy.js');
const suggestionsFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.suggestions.js');
const organizeFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.organize.js');
const duplicateFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.duplicates.js');
const settingsFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.settings.js');
const v3CardsFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.v3.cards.js');
const internalFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.internal.js');
const extendedPort = read('tools/Piano-Auto-Player/web/piano_frontend_extended_port.js');
const pianoLibrary = read('tools/Piano-Auto-Player/app/library.py');
const frontendAppBridge = read('tools/Piano-Auto-Player/web/piano_frontend_app_bridge.js');
const css = read('js/modules/features/audioflix/audioflix.piano.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.ports.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.media.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.organize.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.settings.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.v3.css');
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
assert(frontend.includes('saveOfflinePreview(songs)'), 'backend library sync automatically persists the read-only offline projection');
assert(frontend.includes("IDBStore?.set?.(OFFLINE_IDB_KEY") && frontend.includes("IDBStore?.get?.(OFFLINE_IDB_KEY"), 'offline Piano library must use the durable IndexedDB projection');
assert(!frontend.includes('importOfflinePreview') && !frontend.includes('data-pf-offline-file'), 'do not expose a manual songs.json import path');
assert(frontend.includes('if (!bridgeReady) applyLibrary'), 'direct fallback must not overwrite bridge-owned library');
assert(css.includes('> .audioflix-piano-header { display: none; }'), 'frontend must keep technical lifecycle controls in Backend');
assert(!presentationPorts.includes('Backend Player Queue'), 'frontend copy must not expose Backend wiring');
assert(frontendAppBridge.includes('eveos:piano:internal-play:v1'), 'Internal Play must have a durable Backend preference');
assert(frontendAppBridge.includes('eveos:piano:target-window:v1'), 'Target Window must have a durable Backend preference');
assert(organizeFrontend.includes("ports.command?.('song:update'"), 'Piano organization must use the Backend song owner');
assert(organizeFrontend.includes('data-piano-suggest="folder"') && suggestionsFrontend.includes("role', 'listbox"), 'taxonomy inputs must use the bounded EveOS suggestion UI');
assert(taxonomyFrontend.includes("raw.replace(/'/g, '\"')"), 'legacy serialized memberships must be normalized instead of rendered as literal brackets');
assert(organizeFrontend.includes('optimisticAssignments.set') && organizeFrontend.includes("ports.command?.('song:update', payload) === false"), 'membership removal must repaint immediately and roll back if the Backend refuses it');
assert(mediaFrontend.includes("ports.command?.('song:update'"), 'listener metadata must use the shared Backend port');
assert(mediaFrontend.includes("ports.command?.('progress:seek'"), 'listener seek must use the existing Backend progress owner');
assert(settingsFrontend.includes("ports.command?.('queue:reorder'"), 'Piano Internal View must reorder the shared Backend queue');
assert(organizeFrontend.includes("ports.command?.('queue:add-many'"), 'filtered group queueing must use one Backend queue command');
assert(!organizeFrontend.includes('slice(0, 60)'), 'queue previews must show the complete supported candidate set');
assert(extendedPort.includes('piano_folders_v1: cleanList'), 'multi-folder metadata must stay Backend-owned and structured');
assert.match(extendedPort, /const cleanList = \(value, limit = 60, count = 80\)/, 'the browser bridge must retain up to 80 tag and membership values');
assert.match(pianoLibrary, /def _clean_values\(raw:[\s\S]{0,220}\)\)\[:80\]/, 'the Python owner must retain the same 80-value contract');
assert(settingsFrontend.includes('data-pfs-folders') && settingsFrontend.includes('data-pfs-groups')
  && !settingsFrontend.includes('data-pfs-folder ') && !settingsFrontend.includes('data-pfs-group '),
  'song settings must edit structured multi-folder and multi-group values rather than legacy singleton fields');
assert(internalFrontend.includes("window.open('','eveos-piano-internal-viewer'"), 'Internal Viewer must retain its bounded detachable projection');
assert(!internalFrontend.includes('new Audio(') && !internalFrontend.includes('PianoPlaybackOwner ='), 'Internal Viewer must never create a second playback owner');

const childHtml = `<!doctype html><html><body><script type="module">
import { setupPianoFrontendPort } from '/port.js';
window.__calls = [];
window.__songs = [
  { id: 'one', title: 'Moonlight', artist: 'Composer', sheet: 'abc', source_url:'https://youtu.be/shared123?si=one', identifiers:{personal_rating:4.5,tags:['Calm'],custom:{piano_group:'Study',piano_playback_v1:{route:'internal',layout:'88'}}}, updated_at: Date.now() },
  { id: 'two', title: 'Danger <img src=x onerror=alert(1)>', source_url:'https://www.youtube.com/watch?v=shared123&utm_source=test', identifiers:{tags:['Loud'],custom:{piano_group:'Concert',piano_playback_v1:{route:'target'}}}, performance: [{key:'a'}], updated_at: 200 }
];
setupPianoFrontendPort({
 api: { songs: async () => ({ songs: window.__songs }), saveSong: async song => { const index=window.__songs.findIndex(item=>item.id===song.id);if(index>=0)window.__songs[index]=song;window.__calls.push(['save',song.id,song.identifiers?.custom?.piano_duplicate_keep_v1||'']); } },
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
   await page.addScriptTag({content:taxonomyFrontend});
  await page.addScriptTag({content:organizeFrontend});
  await page.addScriptTag({content:duplicateFrontend});
  await page.addScriptTag({content:settingsFrontend});
  await page.addScriptTag({content:v3CardsFrontend});
  await page.addScriptTag({content:internalFrontend});
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
   assert.equal(await page.locator('.piano-frontend-transport').evaluate(el=>getComputedStyle(el).justifyContent),'center','Piano transport group must be centered at wide and narrow widths');
   const transportSpacing=await page.locator('.piano-frontend-transport').evaluate(el=>({bottom:parseFloat(getComputedStyle(el).paddingBottom),divider:parseFloat(getComputedStyle(el).borderBottomWidth)}));
   assert(transportSpacing.bottom>=20 && transportSpacing.divider===0, 'Transport controls float above Event View without touching a lower divider');
  if (width === 1440) {
   assert.equal(await page.locator('[data-pfs-settings-button]').count(),2,'Music-style Piano cards expose song settings');
   assert.equal(await page.locator('[data-pfs-eye-button]').count(),2,'Every song card has direct Piano Internal View entry');
   assert.equal(await page.locator('[data-pfv3-progress]').count(),2,'Every song card has an inline playback progress projection');
   assert.equal(await page.locator('[data-pfv3-pause]').count(),2,'Every song card carries a pause/resume control');
   assert.equal(await page.locator('[data-pfv3-smart]').count(),6,'Dedicated Smart Piano scopes are mounted');
   await page.locator('[data-pfv3-smart="top"]').click();
   assert.equal(await page.locator('.piano-frontend-song').count(),1,'Top Rated Smart scope filters through the shared library');
   assert.equal(await page.evaluate(()=>localStorage.getItem('evePianoFrontendSmartScopeV1')),'top','Smart scope persists');
   await page.locator('[data-pfv3-smart="top"]').click();
   await page.locator('.piano-frontend-song[data-song-id="one"] [data-pfs-eye-button]').click();
   assert.equal(await page.locator('.piano-pfiv-overlay').isVisible(),true,'Eye opens the dedicated shared-queue Piano Internal Viewer');
   assert.equal(await child.evaluate(()=>window.__calls.filter(x=>x[0]==='play').length),0,'Opening Internal View must not play the song');
   await page.keyboard.press('Escape');
   assert.equal(await page.evaluate(()=>document.activeElement?.hasAttribute('data-pfs-eye-button')),true,'closing Internal Viewer restores keyboard focus to its opener');
   await page.locator('.piano-frontend-song[data-song-id="one"] [data-pfs-settings-button]').click();
   assert.equal(await page.locator('[data-pfs-route]').inputValue(),'internal','card settings project the Backend-owned playback override');
   assert((await page.locator('[data-pfs-duplicates] > div').count())>=1,'exact source matches are shown as non-destructive duplicate suggestions');
   assert.equal(await page.locator('[data-pfs-action="merge-metadata"]').count(),1,'duplicate review offers a safe metadata-only merge');
   await page.locator('[data-pfs-action="keep-both"]').click();
   await child.waitForFunction(()=>window.__calls.some(call=>call[0]==='save'&&call[1]==='one'&&call[2].includes('two')));
   assert.equal(await page.locator('.piano-pfs-duplicate-row').count(),0,'Keep Both decision removes only the warning and persists through Backend metadata');
   await page.locator('[data-pfs-action="close"]').click();
   await page.locator('[data-pfo-action="groups"]').click();
   await page.locator('[data-pfo-route-filter]').selectOption('internal');
   assert.equal(await page.locator('.piano-frontend-song').count(),1,'route filters operate over the shared Backend library');
   await page.locator('[data-pfo-route-filter]').selectOption('all');
   await page.locator('[data-pfo-action="queue-preview"]').click();
   assert.equal(await page.locator('[data-pfo-queue-preview]').isVisible(),true,'bulk queue construction requires an explicit candidate preview');
   assert.equal(await page.locator('[data-pfo-queue-candidates] li').count(),2,'preview uses the combined visible library scope');
   await page.locator('[data-pfo-route-filter]').selectOption('internal');
   assert.equal(await page.locator('[data-pfo-queue-preview]').isHidden(),true,'changing the filtered set invalidates the reviewed queue snapshot');
   await page.locator('[data-pfo-route-filter]').selectOption('all');
   await page.locator('[data-pfo-action="queue-preview"]').click();
   await page.locator('[data-pfo-action="queue-cancel"]').click();
    assert.equal(await page.locator('[data-pfo-exclude],.piano-pfo-exclude').count(),0,'No standalone minus/exclude controls appear in scope selectors');
   const study=page.locator('[data-pfo-groups] [data-pfo-group]').filter({hasText:'Study'});
   await study.click();
   assert.equal(await study.getAttribute('data-focus-state'),'included','First group click includes Study');
   assert.equal(await study.getAttribute('aria-pressed'),'true','Included scope is announced as active');
   assert.equal(await page.locator('.piano-frontend-song').count(),1,'Included Study narrows results');
   await study.click();
   assert.equal(await study.getAttribute('data-focus-state'),'excluded','Second group click excludes Study');
   assert.equal(await study.getAttribute('aria-pressed'),'true','Excluded scope is announced as active');
   assert.equal(await study.evaluate(el=>el.classList.contains('is-excluded')),true,'Excluded group uses danger styling');
   assert.equal(await page.locator('.piano-frontend-song').count(),1,'Excluded Study narrows to non-Study songs');
   await study.click();
   assert.equal(await study.getAttribute('data-focus-state'),'neutral','Third group click clears Study focus');
   assert.equal(await study.getAttribute('aria-pressed'),'false','Cleared group scope is announced as neutral');
   assert.equal(await page.locator('.piano-frontend-song').count(),2,'Clearing Study restores all songs');
   await page.locator('[data-pfo-action="classifiers"]').click();
   const calm=page.locator('[data-pfo-classifiers] [data-pfo-classifier]').filter({hasText:'Calm'});
   await calm.click();
   assert.equal(await calm.getAttribute('data-focus-state'),'included','First classifier click includes Calm');
   assert.equal(await page.locator('.piano-frontend-song').count(),1);
   await calm.click();
   assert.equal(await calm.getAttribute('data-focus-state'),'excluded','Second classifier click excludes Calm');
   assert.equal(await calm.evaluate(el=>el.classList.contains('is-excluded')),true,'Excluded tag uses danger styling');
   assert.equal(await page.locator('.piano-frontend-song').count(),1);
   await calm.click();
   assert.equal(await calm.getAttribute('data-focus-state'),'neutral','Third classifier click clears Calm');
   assert.equal(await page.locator('.piano-frontend-song').count(),2);
   assert.equal(await page.locator('[data-pfo-library-groups] [data-pfo-group]').count(),2,'library scope exposes groups in its own labeled row');
   assert.equal(await page.locator('[data-pfo-library-tags] [data-pfo-classifier]').count(),2,'library scope exposes tags in its own labeled row');
   await page.locator('[data-pfo-action="organize"]').click();
   await page.locator('[data-pfo-folder-input]').fill('Practice');
   await page.locator('[data-pfo-group-input]').fill('Favorites');
   await page.locator('[data-pfo-tag-input]').fill('Calm');
   await page.locator('[data-pfo-action="save"]').click();
   await child.waitForFunction(()=>window.__songs[0].identifiers.custom.piano_folders_v1?.includes('Practice'));
   const organized=await child.evaluate(()=>window.__songs[0].identifiers);
   assert.deepEqual(organized.custom.piano_folders_v1,['Practice'],'folder additions persist as a Backend-owned collection');
   assert.deepEqual(organized.custom.piano_groups_v1,['Study','Favorites'],'legacy and new groups migrate without replacement');
   assert.deepEqual(organized.tags,['Calm'],'tag additions preserve existing metadata without duplication');
   assert.equal(await page.locator('[data-pfo-folder-input]').inputValue(),'','successful Apply clears the addition fields');
  }
   await page.waitForFunction(()=>window.EveAudioflixPianoFrontend?.pendingCount?.()===0);
  assert(await page.locator('[data-af-action="piano-frontend-stop"]').isEnabled(),'stop must enable after bridge handshake');
  await page.locator('[data-af-action="piano-frontend-play"][data-song-id="one"]').click();
   try {
    await page.waitForFunction(()=>document.querySelector('[data-pf-message]')?.textContent?.includes('Song sent'),null,{timeout:10000});
    await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='play'&&x[1]==='one'),null,{timeout:5000});
   } catch(error) {
    const evidence=await page.evaluate(()=>({notice:document.querySelector('[data-pf-message]')?.textContent,button:document.querySelector('[data-song-id="one"] .piano-frontend-song-play')?.outerHTML,pending:window.EveAudioflixPianoFrontend?.pendingCount?.(),bridge:window.EveAudioflixPianoFrontend?.bridgeReady?.()}));
    throw new Error(`Responsive Play did not reach the shared Backend at ${width}px: ${JSON.stringify(evidence)}; ${error.message}`);
   }
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
  const unwrapped=await page.evaluate(()=>{const root=document.querySelector('[data-audioflix-piano]'),stage=root.querySelector('.audioflix-piano-stage'),canvas=root.querySelector('.audioflix-piano-frontend');return{stage:getComputedStyle(stage).overflow,position:getComputedStyle(canvas).position,overflow:getComputedStyle(canvas).overflow};});
  assert.deepEqual(unwrapped,{stage:'visible',position:'relative',overflow:'visible'},'Piano Frontend must use the Audioflix page scroll instead of a nested viewport');
  await page.click('[data-piano-view-switch]');
  await child.evaluate(()=>window.__songs.push({id:'four',title:'Backend Refresh Song',updated_at:400}));
  await page.click('[data-af-action="piano-refresh"]');
  await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===4);
  assert.equal(await page.locator('[data-piano-frontend]').isHidden(),true,'Backend Refresh must update the shared Frontend while that view remains hidden');
  await page.click('[data-piano-view-switch]');
  assert((await page.locator('.piano-frontend-song-info strong').allTextContents()).includes('Backend Refresh Song'),'Backend Refresh must invalidate and update the shared Frontend library');
  await page.evaluate(()=>{window.EveAudioflixPiano.state.running=false;window.EveAudioflixPiano.state.phase='stopped';window.EveAudioflixPiano.state.url='';window.dispatchEvent(new Event('eve:audioflix-piano-status'));});
  await page.waitForFunction(()=>document.querySelector('[data-pf-playback]')?.textContent==='Piano offline');
   assert.equal(await page.locator('.piano-frontend-song').count(),4,'offline mode retains last-synced song cards as a read-only preview');
   assert.equal(await page.locator('.piano-frontend-song-play:not(:disabled)').count(),0,'offline song cards cannot start playback');
   assert((await page.locator('[data-pf-message]').textContent()).includes('Offline library preview'), 'offline preview is explicitly labeled as stale');
   const cached=await page.evaluate(()=>JSON.parse(localStorage.getItem('eveos:piano:library-preview:v1')));
   assert.equal(cached?.songs?.length,4,'live library is persisted as a bounded offline projection');
   assert(!('sheet' in cached.songs[0]) && !('performance' in cached.songs[0]), 'offline snapshot excludes raw sheet and performance data');
   assert.equal(await page.locator('[data-pf-offline-import],[data-pf-offline-file]').count(),0,'No manual library-file picker is exposed');
   assert((await page.locator('.piano-frontend-song-info strong').allTextContents()).includes('Backend Refresh Song'), 'Offline view preserves songs synced from the real backend');
   await page.evaluate(()=>window.EveAudioflixPianoFrontend.sync());
   assert.equal(await page.locator('.piano-frontend-song').count(),4,'Repeated offline synchronization must preserve the stored backend projection');
   assert.equal(await page.locator('.piano-frontend-song-play:not(:disabled)').count(),0,'Offline cache remains read-only on repeat synchronization');
  assert.equal(await page.locator('[data-pf-service-start]').isVisible(),true,'frontend must offer a friendly service start action when offline');
  await page.evaluate(()=>{window.EveAudioflixPiano.start=async()=>{window.__frontStartRequested=true;};});
  await page.locator('[data-pf-service-start]').click();
  assert.equal(await page.evaluate(()=>window.__frontStartRequested===true),true,'frontend start action must use the existing lifecycle owner');
  console.log(`PIANO_FRONTEND_LIBRARY_BROWSER_OK viewport=${width} songs=PASS controls=PASS sort=PASS play=PASS shared-refresh=PASS iframe-preserved=PASS offline=PASS`);
 } finally { await page.close(); }
}

(async()=>{const browser=await chromium.launch({headless:true});try{await opaqueRealAppTest(browser,{repo,css,views,frontend,presentationPorts,mediaFrontend,taxonomyFrontend,organizeFrontend,settingsFrontend,ui,installHost});for(const width of [1440,760,480])await syntheticTest(browser,width);await testPianoRetention(browser,retentionSource,read('js/modules/features/audioflix/audioflix.ui.js'));console.log('EVEOS_PIANO_FRONTEND_LIBRARY_BROWSER_PASS');}finally{await browser.close();}})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
