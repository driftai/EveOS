#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(repo, p), 'utf8');
const ui = read('js/modules/features/audioflix/audioflix.piano.ui.js');
const views = read('js/modules/features/audioflix/audioflix.piano.views.js');
const frontend = read('js/modules/features/audioflix/audioflix.piano.frontend.js');
const presentationPorts = read('js/modules/features/audioflix/audioflix.piano.frontend.ports.js');
const mediaFrontend = read('js/modules/features/audioflix/audioflix.piano.frontend.media.js');
const extendedPort = read('tools/Piano-Auto-Player/web/piano_frontend_extended_port.js');
const frontendAppBridge = read('tools/Piano-Auto-Player/web/piano_frontend_app_bridge.js');
const css = read('js/modules/features/audioflix/audioflix.piano.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.ports.css') + '\n' + read('js/modules/features/audioflix/audioflix.piano.frontend.media.css');
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
assert(mediaFrontend.includes("ports.command?.('song:update'"), 'listener metadata must use the shared Backend port');
assert(mediaFrontend.includes("ports.command?.('progress:seek'"), 'listener seek must use the existing Backend progress owner');

const childHtml = `<!doctype html><html><body><script type="module">
import { setupPianoFrontendPort } from '/port.js';
window.__calls = [];
window.__songs = [
  { id: 'one', title: 'Moonlight', artist: 'Composer', sheet: 'abc', updated_at: 100 },
  { id: 'two', title: 'Danger <img src=x onerror=alert(1)>', performance: [{key:'a'}], updated_at: 200 }
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
  await page.addScriptTag({content:ui});
  await installHost(page, 'http://127.0.0.1:8771/piano');
  let child = null;
  for (let attempt = 0; attempt < 80 && !child; attempt++) { child = page.frame({url:'http://127.0.0.1:8771/piano'}); if (!child) await page.waitForTimeout(50); }
  assert(child,'Piano iframe must exist');
  await child.waitForFunction(()=>window.__keep===1147);
  await page.click('[data-piano-view-switch]');
  await page.waitForSelector('.piano-frontend-song-play');
  await page.waitForFunction(()=>document.querySelector('[data-pf-playback]')?.textContent !== 'Connecting…');
  assert(await page.locator('[data-af-action=\"piano-frontend-pause\"]').isEnabled(),'bridge must recover even if the first ready signal races host setup');
  const songs=await page.locator('.piano-frontend-song-info strong').allTextContents();
  assert.equal(songs.length,2); assert(songs.includes('Moonlight'));
  assert.equal(await page.locator('.piano-frontend-song-info img').count(),0,'titles must not be parsed as HTML');
  assert.equal(await page.locator('[data-pf-count]').textContent(),'2 songs');
  assert.equal(await page.locator('.audioflix-piano-header').evaluate(el=>getComputedStyle(el).display),'none','technical Piano Automation toolbar must stay in Backend');
  assert.equal(await page.locator('.piano-frontend-title h2').textContent(),'My Piano Music');
  assert.equal(await page.locator('[data-piano-view-title]').textContent(),'Piano Library');
  assert(await page.locator('[data-af-action="piano-frontend-stop"]').isEnabled(),'stop must enable after bridge handshake');
  await page.locator('[data-af-action="piano-frontend-play"][data-song-id="one"]').click();
  await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='play'&&x[1]==='one'));
  await page.waitForFunction(()=>document.querySelector('[data-pf-message]')?.textContent?.includes('Song sent'));
  await page.click('[data-af-action="piano-frontend-pause"]'); await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='pause'));
  await page.click('[data-af-action="piano-frontend-stop"]'); await child.waitForFunction(()=>window.__calls?.some(x=>x[0]==='stop'));
  await page.locator('[data-pf-search]').fill('Moon'); assert.equal(await page.locator('.piano-frontend-song').count(),1);
  await page.locator('[data-pf-search]').fill('');
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
  await page.click('[data-piano-view-switch]');
  await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===4);
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

function freePort() {
 return new Promise((resolve,reject)=>{const s=net.createServer();s.unref();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
}
function waitHttp(url, timeout=10000) {
 const start=Date.now();
 return new Promise((resolve,reject)=>{const tick=()=>{const req=http.get(url,res=>{res.resume();if(res.statusCode===200)return resolve();setTimeout(tick,80);});req.on('error',()=>{if(Date.now()-start>timeout)return reject(new Error(`Timed out waiting for ${url}`));setTimeout(tick,80);});};tick();});
}

async function opaqueRealAppTest(browser) {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'eveos-piano-front-'));
 const portNumber=await freePort();
 const songFile=path.join(temp,'songs.json');
 const launcher=path.join(temp,'server.py');
 const tool=path.join(repo,'tools','Piano-Auto-Player');
 fs.writeFileSync(launcher, `import sys, pathlib\nsys.path.insert(0, ${JSON.stringify(tool)})\nfrom app import server\nfrom app.library import SongLibrary\nserver.LIBRARY=SongLibrary(pathlib.Path(${JSON.stringify(songFile)}))\nserver.LIBRARY.save({'id':'opaque-one','title':'Opaque One','sheet':'a b c','identifiers':{'genre':['Classical'],'tags':['warm'],'author':'Piano Author','personal_rating':4.5}})\nserver.LIBRARY.save({'id':'opaque-two','title':'Opaque Two','sheet':'d e f'})\nserver.run('127.0.0.1', ${portNumber})\n`);
 const parentFile=path.join(temp,'parent.html');
 fs.writeFileSync(parentFile,'<!doctype html><html><head></head><body style="margin:0;background:#090f12"><main id="test-root"></main></body></html>');
 const python=process.env.PYTHON || 'python';
 const child=spawn(python,[launcher],{cwd:repo,stdio:['ignore','pipe','pipe']});
 let stderr=''; child.stderr.on('data',chunk=>{stderr+=String(chunk);});
 try {
  await waitHttp(`http://127.0.0.1:${portNumber}/api/status`);
  const page=await browser.newPage({viewport:{width:1180,height:860}});
  const transientModuleFailures=new Map();
  await page.route(/\/assets\/(player_queue|sheet_progress)\.js(?:\?|$)/,async route=>{
   const name=new URL(route.request().url()).pathname.split('/').pop();
   const count=transientModuleFailures.get(name)||0; transientModuleFailures.set(name,count+1);
   if(count===0) await route.abort('connectionrefused'); else await route.continue();
  });
  const consoleLines=[]; const pageErrors=[];
  page.on('console',msg=>consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror',error=>pageErrors.push(String(error?.stack||error)));
  try {
   await page.goto(pathToFileURL(parentFile).href);
   await page.addStyleTag({content:css}); await page.addScriptTag({content:views}); await page.addScriptTag({content:frontend}); await page.addScriptTag({content:presentationPorts}); await page.addScriptTag({content:mediaFrontend}); await page.addScriptTag({content:ui});
   await installHost(page,`http://127.0.0.1:${portNumber}/`);
   let realChild=null;
   for(let attempt=0;attempt<100&&!realChild;attempt++){realChild=page.frames().find(frame=>frame.url()===`http://127.0.0.1:${portNumber}/`);if(!realChild)await page.waitForTimeout(50);}
   assert(realChild,'real Piano iframe must load under file-origin parent');
   await realChild.waitForFunction(()=>window.__eveosPianoFrontendPortReady===true,{timeout:10000});
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState&&document.getElementById('sheetProgressStyles'),{timeout:10000});
   assert.equal(transientModuleFailures.get('player_queue.js')>=2,true,'Player Queue loader must retry a transient module fetch failure');
   assert.equal(transientModuleFailures.get('sheet_progress.js')>=2,true,'Sheet Progress loader must retry a transient module fetch failure');
   const bridgeEvidence=await realChild.evaluate(()=>({ready:window.__eveosPianoFrontendPortReady===true,announcements:Number(window.__eveosPianoFrontendPortAnnouncements||0),status:document.getElementById('statusText')?.textContent||'',href:location.href}));
   assert(bridgeEvidence.ready,`real Piano bridge did not install: ${JSON.stringify(bridgeEvidence)}`);
   const bridgeConnectStarted=Date.now();
   await page.click('[data-piano-view-switch]');
   assert.equal(await page.locator('.audioflix-piano-header').evaluate(el=>getComputedStyle(el).display),'none','real file-origin frontend must hide technical launcher controls');
   assert.equal(await page.locator('.piano-frontend-title h2').textContent(),'My Piano Music');
   assert.equal(await page.locator('[data-piano-view-title]').textContent(),'Piano Library');
   await page.waitForFunction(()=>document.querySelector('[data-pf-count]')?.textContent==='2 songs',{timeout:10000});
   await page.waitForFunction(()=>document.querySelector('[data-pf-playback]')?.textContent!=='Connecting…',{timeout:10000});
    await page.waitForFunction(()=>document.querySelector('[data-af-action="piano-frontend-pause"]')?.disabled===false,{timeout:10000});
    assert(Date.now()-bridgeConnectStarted<2000,'Frontend playback bridge must publish its initial projection without a polling delay');
   assert(await page.locator('[data-af-action="piano-frontend-pause"]').isEnabled(),`opaque/file parent must establish playback bridge; child=${JSON.stringify(bridgeEvidence)} console=${consoleLines.join(' | ')} errors=${pageErrors.join(' | ')}`);
   const titles=await page.locator('.piano-frontend-song-info strong').allTextContents();
   assert.deepEqual(new Set(titles),new Set(['Opaque One','Opaque Two']));
   await page.waitForSelector('[data-pxp-layout] option[value="88"]',{timeout:10000,state:'attached'});
   assert.equal(await page.locator('[data-pxp-target]').count(),1,'target selector must be surfaced');
   assert.equal(await page.locator('[data-pxp-internal]').count(),1,'Internal Play must be surfaced');
   assert.equal(await page.locator('.piano-pxp-controls').getAttribute('open'),null,'Playback setup must start collapsed');
   assert.equal(await page.evaluate(()=>document.querySelector('.piano-pxp-controls')?.nextElementSibling?.classList.contains('piano-pxp-queue')),true,'Player Queue must sit directly below Playback setup');
   await page.locator('.piano-pxp-controls > summary').click();
   assert.equal(await page.locator('.piano-pxp-controls').getAttribute('open'),'','Playback setup must open when requested');
    const internalGeometry=await page.locator('.piano-pxp-toggle').evaluate(node=>{const label=node.querySelector('span').getBoundingClientRect(),toggle=node.querySelector('input').getBoundingClientRect();return{labelRight:label.right,toggleLeft:toggle.left,labelY:label.top+label.height/2,toggleY:toggle.top+toggle.height/2};});
    assert(internalGeometry.toggleLeft>=internalGeometry.labelRight-2&&Math.abs(internalGeometry.toggleY-internalGeometry.labelY)<12,'Internal Play toggle must sit beside its label');
   await page.locator('[data-pxp-layout]').selectOption('88');
   await realChild.waitForFunction(()=>document.getElementById('pianoLayout')?.value==='88');
   assert.equal(await realChild.evaluate(()=>localStorage.getItem('eveos:piano:layout:v1')),'88');
   await page.locator('[data-pxp-sound]').selectOption('legacy_synth');
   await realChild.waitForFunction(()=>document.getElementById('pianoSound')?.value==='legacy_synth');
   await page.locator('[data-pxp-internal]').check();
   await realChild.waitForFunction(()=>document.getElementById('internalPlay')?.checked===true);
   assert.equal(await realChild.evaluate(()=>localStorage.getItem('eveos:piano:internal-play:v1')),'true','Internal Play must persist through the Backend owner');
   await page.waitForFunction(()=>document.querySelector('[data-pxp-target]')?.disabled === true);
   await page.locator('[data-pxp-internal]').uncheck();
   await realChild.waitForFunction(()=>document.getElementById('internalPlay')?.checked===false);
   await page.waitForFunction(()=>document.querySelector('[data-pxp-target]')?.disabled === false);
   await realChild.evaluate(()=>{const target=document.getElementById('windowSelect');target.disabled=true;target.dispatchEvent(new Event('change',{bubbles:true}));});
   await page.waitForFunction(()=>document.querySelector('[data-pxp-target]')?.disabled === true);
   await realChild.evaluate(()=>{const target=document.getElementById('windowSelect');target.disabled=false;target.dispatchEvent(new Event('change',{bubbles:true}));});
   await page.waitForFunction(()=>document.querySelector('[data-pxp-target]')?.disabled === false);
   await page.waitForFunction(()=>document.querySelector('[data-pxp-queue-count]')?.textContent === '0 queued',{timeout:10000});
   assert.equal(await page.locator('.piano-pxm-listener').count(),1,'listener-facing media surface must mount once');
   await page.evaluate(()=>window.EveAudioflixPianoFrontendPorts.command('song:load',{songId:'opaque-one'}));
   await page.waitForFunction(()=>document.querySelector('[data-pxm-current]')?.textContent==='Opaque One',{timeout:10000});
   assert.equal(await page.locator('[data-af-action="piano-frontend-media-current-favorite"]').isEnabled(),true,'current-song metadata controls must follow the Backend current song');
   assert.equal(await page.locator('.piano-pxm-now').getAttribute('open'),null,'song controls must start collapsed');
   await page.locator('.piano-pxm-now > summary').click();
   await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'playing',current_index:2,total_events:3,sheet_total:3,timing_profile:'expressive',current_token:'b'}})));
   await page.waitForFunction(()=>document.querySelector('.piano-pxm-sheet-current')?.textContent==='b');
   assert.equal(await page.locator('.piano-pxm-sheet-current').textContent(),'b','Frontend sheet details must project the Backend current-event range');
   await page.locator('.piano-pxm-history > summary').click();
   await page.waitForFunction(()=>document.querySelectorAll('[data-pxm-history-list] button').length===1);
   await page.locator('[data-af-action="piano-frontend-media-current-favorite"]').click();
    assert((await page.locator('[data-af-action="piano-frontend-media-current-favorite"]').textContent()).includes('★'),'favorite control must update optimistically on the same click');
   await realChild.waitForFunction(async()=>{const response=await fetch('/api/songs');const body=await response.json();return body.songs?.find(song=>song.id==='opaque-one')?.identifiers?.custom?.favorite==='true';});
   await page.waitForFunction(()=>document.querySelector('[data-af-action="piano-frontend-media-current-favorite"]')?.textContent.includes('★'));
    await page.waitForFunction(()=>window.EveAudioflixPianoFrontend?.pendingCount?.()===0);
   await realChild.evaluate(()=>window.parent.postMessage({type:'piano:eveos-port-update',queue:{mode:'ordered',currentId:'q2',items:[{queueId:'q1',songId:'one',label:'Played One'},{queueId:'q2',songId:'two',label:'Current Two'},{queueId:'q3',songId:'three',label:'Next Three'}]}},'*'));
   await page.waitForFunction(()=>document.querySelector('[data-pxp-next]')?.textContent==='Next Three');
   await page.evaluate(()=>{window.__stablePianoSongRow=document.querySelector('.piano-frontend-song[data-song-id="opaque-one"]');});
   await page.locator('[data-af-action="piano-frontend-port-queue-add"][data-song-id="opaque-one"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.some(item=>item.songId==='opaque-one'));
   await page.waitForFunction(()=>document.querySelector('[data-pxp-queue-count]')?.textContent==='1 queued');
   assert.equal(await page.evaluate(()=>document.querySelector('.piano-frontend-song[data-song-id="opaque-one"]')===window.__stablePianoSongRow),true,'queue updates must not rebuild the full song library');
   await page.locator('[data-af-action="piano-frontend-port-queue-add"][data-song-id="opaque-one"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.filter(item=>item.songId==='opaque-one').length===2);
   const duplicateIds=await realChild.evaluate(()=>window.PianoPlayerQueue.getState().items.filter(item=>item.songId==='opaque-one').map(item=>item.queueId));
   await page.locator('[data-af-action="piano-frontend-port-queue-remove-song"][data-song-id="opaque-one"]').click();
   await realChild.waitForFunction(id=>{const items=window.PianoPlayerQueue?.getState?.().items||[];return items.length===1&&items[0].queueId===id;},duplicateIds[0]);
   await page.waitForFunction(()=>document.querySelector('[data-pxp-queue-count]')?.textContent==='1 queued');
    // The Backend queue is intentionally a disclosure: expand it before using transport.
    assert.equal(await page.locator('.piano-pxp-queue').getAttribute('open'),null,'queue starts collapsed');
   await page.locator('.piano-pxp-queue > summary').click();
    await page.waitForFunction(()=>document.querySelector('.piano-pxp-queue')?.open===true);
   await page.locator('[data-pxp-mode]').selectOption('manual');
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().mode==='manual');
   await page.locator('[data-af-action="piano-frontend-port-queue-add"][data-song-id="opaque-two"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.length===2);
   await page.waitForFunction(()=>document.querySelectorAll('.piano-pxp-queue-row[draggable="true"]').length===2);
   const orderBeforeDrag=await realChild.evaluate(()=>window.PianoPlayerQueue.getState().items.map(item=>item.queueId));
   await page.locator('.piano-pxp-queue-row').nth(1).dragTo(page.locator('.piano-pxp-queue-row').nth(0),{targetPosition:{x:20,y:2}});
   await realChild.waitForFunction(expected=>window.PianoPlayerQueue?.getState?.().items?.[0]?.queueId===expected,orderBeforeDrag[1]);
   assert.equal(await page.locator('.piano-pxp-queue-row').first().getAttribute('data-queue-id'),orderBeforeDrag[1],'frontend drag must reorder the Backend PlayerQueue');
   await page.locator('.piano-pxp-queue-row').first().locator('[data-af-action="piano-frontend-port-queue-duplicate"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.length===3);
   assert.equal(await page.locator('.piano-pxp-queue-row').first().locator('button').allTextContents().then(items=>items.includes('+')&&items.includes('−')),true,'manual queue rows must expose + and − entry controls');
   await page.locator('[data-pxp-mode]').selectOption('ordered');
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().mode==='ordered');
   await page.locator('[data-pxp-scope="queued"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===2);
   assert.deepEqual((await page.locator('.piano-frontend-song-info strong').allTextContents()).sort(),['Opaque One','Opaque Two']);
   await page.locator('[data-pxp-scope="all"]').click();
    // Advanced metadata filters are likewise hidden until the user expands them.
   await page.locator('.piano-pxp-advanced > summary').click();
    await page.waitForFunction(()=>document.querySelector('.piano-pxp-advanced')?.open===true);
   await page.locator('[data-pxp-genre]').selectOption('Classical');
   await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===1);
   await page.locator('[data-af-action="piano-frontend-port-filters-clear"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===2);
   await realChild.evaluate(() => window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',
     { detail: { status:'playing', current_index:3, total_events:12, current_token:'[4q]' } })));
   await page.waitForFunction(() => document.querySelector('[data-pxp-event-count]')?.textContent === '3 / 12 events', { timeout: 5000 });
   assert.equal(await page.locator('[data-pxp-event-token]').textContent(),'[4q]','current note must mirror the Backend event view');
   assert.equal(await page.locator('[data-pxp-event-rail]').getAttribute('aria-valuenow'),'3');
   assert.equal(await page.locator('[data-pxp-event-rail]').getAttribute('aria-valuemax'),'12');
   await realChild.evaluate(() => window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',
     { detail: { status:'playing', current_index:0, total_events:12, current_token:'a' } })));
   await page.waitForFunction(() => document.querySelector('[data-pxp-event-count]')?.textContent === '0 / 12 events');
   assert.equal(await page.locator('[data-pxp-event-rail]').getAttribute('aria-valuenow'),'0','new-song progress must not retain a stale nonzero index');
   await page.locator('[data-af-action="piano-frontend-port-queue-clear"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.length===0);
   await realChild.evaluate(()=>window.PianoPlayerQueue.addSong({id:'opaque-two',title:'Opaque Two',sheet:'d e f'},false));
   await page.waitForFunction(()=>document.querySelector('[data-pxp-queue-count]')?.textContent==='1 queued');
   assert.equal(await page.locator('.piano-frontend-song[data-song-id="opaque-two"] [data-pxp-queued-count]').textContent(),'1 queued','Backend queue mutations must project into the same Frontend queue state');
    await page.locator('[data-pxp-internal]').check();
    await realChild.evaluate(()=>{const countdown=document.getElementById('countdownRange');countdown.value='0';countdown.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await realChild.evaluate(()=>typeof window.PianoPlaybackOwner?.playSong),'function','Backend must expose one playback owner to its queue and Frontend ports');
    await page.locator('[data-af-action="piano-frontend-port-queue-play"]').click();
    await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().active===true&&['countdown','playing'].includes(document.getElementById('statusChip')?.dataset.state),null,{timeout:10000});
    await page.waitForFunction(()=>document.querySelector('[data-af-action="piano-frontend-port-queue-play"]')?.textContent==='Playing queue');
    await page.locator('[data-af-action="piano-frontend-port-queue-stop"]').click();
    await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().active===false);
    await page.waitForFunction(()=>document.querySelector('[data-af-action="piano-frontend-port-queue-play"]')?.textContent!=='Playing queue');
   await page.locator('[data-af-action="piano-frontend-port-queue-clear"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.length===0);
   assert.equal(await realChild.evaluate(()=>window.__eveosPianoFrontendPortReady),true,'existing playback port must survive');
    const songPlay=page.locator('.piano-frontend-song[data-song-id="opaque-one"] .piano-frontend-song-play');
    await songPlay.click();
    await realChild.waitForFunction(()=>['countdown','playing'].includes(document.getElementById('statusChip')?.dataset.state),null,{timeout:10000});
    await page.waitForFunction(()=>document.querySelector('.piano-frontend-song[data-song-id="opaque-one"] .piano-frontend-song-play')?.textContent==='Stop');
    await songPlay.click();
    await realChild.waitForFunction(()=>document.getElementById('statusChip')?.dataset.state==='idle',null,{timeout:10000});
    await page.waitForFunction(()=>document.querySelector('.piano-frontend-song[data-song-id="opaque-one"] .piano-frontend-song-play')?.textContent==='Play');
    await realChild.evaluate(()=>{const node=document.getElementById('internalPlay');node.checked=true;node.dispatchEvent(new Event('change',{bubbles:true}));});
   await realChild.waitForFunction(()=>localStorage.getItem('eveos:piano:internal-play:v1')==='true');
   await realChild.evaluate(()=>{window.__pianoRefreshMarker='stale-runtime';});
   await page.click('[data-piano-view-switch]');
   await page.click('[data-af-action="piano-refresh"]');
   await realChild.waitForFunction(()=>window.__pianoRefreshMarker===undefined,null,{timeout:10000});
   await realChild.waitForFunction(()=>window.__eveosPianoFrontendPortReady===true&&document.getElementById('internalPlay')?.checked===true,{timeout:10000});
   assert.equal(await realChild.evaluate(()=>document.getElementById('internalPlay')?.checked),true,'Internal Play must restore after reload');
   await page.click('[data-piano-view-switch]');
   await page.waitForFunction(()=>window.EveAudioflixPianoFrontend?.bridgeReady?.()===true,null,{timeout:10000});
   assert.equal(await page.evaluate(()=>window.EveAudioflixPianoFrontendPorts.command('song:load',{songId:'opaque-one'})),true,'Frontend command port must accept work after Backend Refresh');
   await realChild.waitForFunction(()=>document.getElementById('titleInput')?.value.includes('Opaque One'),null,{timeout:10000});
   await page.waitForFunction(()=>document.querySelector('[data-pxm-current]')?.textContent==='Opaque One',null,{timeout:10000});
   console.log(`PIANO_FRONTEND_PORTS_REAL_APP_OK origin=file targets=PASS internal=PASS layout=PASS sound=PASS metadata=PASS scope=PASS queue=PASS queue-sync=PASS module-retry=PASS layout-order=PASS events=PASS`);
   console.log(`PIANO_FRONTEND_OPAQUE_REAL_APP_OK origin=file library=PASS bridge=PASS controls=PASS announcements=${bridgeEvidence.announcements}`);
  } catch (error) {
    throw new Error(`${error.stack || error.message}\nReal Piano browser console:\n${consoleLines.slice(-40).join(' | ')}\nReal Piano page errors:\n${pageErrors.slice(-20).join(' | ')}`);
  } finally { await page.close(); }
 } catch (error) { throw new Error(`${error.message}\nPiano server stderr:\n${stderr}`); }
 finally { child.kill(); fs.rmSync(temp,{recursive:true,force:true}); }
}

(async()=>{const browser=await chromium.launch({headless:true});try{await opaqueRealAppTest(browser);for(const width of [1440,760,480])await syntheticTest(browser,width);console.log('EVEOS_PIANO_FRONTEND_LIBRARY_BROWSER_PASS');}finally{await browser.close();}})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
