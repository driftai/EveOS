'use strict';
// Real Piano server, Internal Play, queue, seek, and view-only Browser qualification.
// Test-only helper; entrypoint retains synthetic UI and static integration checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { assertTransportContinuity } = require('./piano_frontend_transport_real_app.cjs');

function freePort() {
 return new Promise((resolve,reject)=>{const s=net.createServer();s.unref();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
}
function waitHttp(url, timeout=10000) {
 const start=Date.now();
 return new Promise((resolve,reject)=>{const tick=()=>{const req=http.get(url,res=>{res.resume();if(res.statusCode===200)return resolve();setTimeout(tick,80);});req.on('error',()=>{if(Date.now()-start>timeout)return reject(new Error(`Timed out waiting for ${url}`));setTimeout(tick,80);});};tick();});
}

async function opaqueRealAppTest(browser, {repo, css, views, frontend, presentationPorts, mediaFrontend, organizeFrontend, ui, installHost}) {
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
   await page.addStyleTag({content:css}); await page.addScriptTag({content:views}); await page.addScriptTag({content:frontend}); await page.addScriptTag({content:presentationPorts}); await page.addScriptTag({content:mediaFrontend}); await page.addScriptTag({content:organizeFrontend}); await page.addScriptTag({content:ui});
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
   assert.equal(await page.locator('.piano-frontend-title h2').textContent(),'Piano Auto Player - Frontend');
   assert.equal(await page.locator('.piano-frontend-inner > .piano-frontend-header').count(),1,'Piano title must remain outside the collapsible workspace');
   assert.equal(await page.locator('[data-piano-view-title]').textContent(),'Piano Library');
   await page.waitForFunction(()=>document.querySelector('[data-pf-count]')?.textContent==='2 songs',{timeout:10000});
   await page.waitForFunction(()=>document.querySelector('[data-pf-playback]')?.textContent!=='Connecting…',{timeout:10000});
    try {
     await page.waitForFunction(()=>document.querySelector('.piano-frontend-transport [data-af-action="piano-frontend-pause"]')?.disabled===false,null,{timeout:10000});
    } catch(error) {
     const projection=await page.evaluate(()=>{const panel=document.querySelector('[data-audioflix-piano]');return{ready:window.EveAudioflixPianoFrontend?.bridgeReady?.(),pending:window.EveAudioflixPianoFrontend?.pendingCount?.(),status:document.querySelector('[data-pf-playback]')?.outerHTML,pause:document.querySelector('.piano-frontend-transport [data-af-action="piano-frontend-pause"]')?.outerHTML,notice:document.querySelector('[data-pf-message]')?.textContent,view:panel?.dataset?.pianoView,running:panel?.dataset?.running};});
     throw new Error(`Frontend playback bridge did not become ready: ${JSON.stringify(projection)}; ${error.message}`);
    }
    assert(Date.now()-bridgeConnectStarted<2000,'Frontend playback bridge must publish its initial projection without a polling delay');
   assert.equal(await page.locator('.piano-frontend-transport [data-af-action="piano-frontend-pause"]').count(),1,'main Pause transport must have one target');
   assert.equal(await page.locator('[data-pxm-compact-pause]').count(),1,'compact Pause control must mount independently');
   assert(await page.locator('.piano-frontend-transport [data-af-action="piano-frontend-pause"]').isEnabled(),`opaque/file parent must establish playback bridge; child=${JSON.stringify(bridgeEvidence)} console=${consoleLines.join(' | ')} errors=${pageErrors.join(' | ')}`);
   const titles=await page.locator('.piano-frontend-song-info strong').allTextContents();
   assert.deepEqual(new Set(titles),new Set(['Opaque One','Opaque Two']));
   assert.equal(await page.locator('.piano-pfo-toolbar').count(),1,'Piano library toolbar must mount once');
   for (const drawer of ['data-pfo-manager','data-pfo-group-panel','data-pfo-classifier-panel','data-pfo-search-panel']) {
    assert.equal(await page.locator(`[${drawer}]`).isVisible(),false,`Organizer ${drawer} must start hidden`);
   }
   await page.locator('[data-pfo-action="groups"]').click();
   assert.equal(await page.locator('[data-pfo-group-panel]').isVisible(),true,'Groups button must reveal its drawer');
   await page.locator('[data-pfo-action="classifiers"]').click();
   assert.equal(await page.locator('[data-pfo-group-panel]').isVisible(),false,'Opening Classifiers must close Groups');
   assert.equal(await page.locator('[data-pfo-classifier-panel]').isVisible(),true,'Classifiers must be enclosed in its own drawer');
   await page.locator('[data-pfo-action="nexus"]').click();
   assert.equal(await page.locator('[data-pfo-classifier-panel]').isVisible(),false,'Opening Nexus must close Classifiers');
   assert.equal(await page.locator('[data-pfo-search-panel]').isVisible(),true,'Nexus search must be hidden until requested');
   await page.locator('[data-pfo-action="nexus"]').click();
   assert.equal(await page.locator('[data-pfo-search-panel]').isVisible(),false,'Clicking a second time collapses drawer');
   assert.equal(await page.locator('.piano-pfo-actions button:disabled').count(),2,'future Localize and Piano Port actions must remain visibly staged');
   const cardGeometry=await page.locator('.piano-frontend-song').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width)}}));
   assert(cardGeometry.length===2&&cardGeometry[0].y===cardGeometry[1].y&&cardGeometry[0].x!==cardGeometry[1].x,`wide Piano Frontend must use compact Soundboard-style cards: ${JSON.stringify(cardGeometry)}`);
   await page.locator('[data-pfo-action="organize"]').click();
   await page.locator('[data-pfo-song]').selectOption('opaque-one');
   await page.locator('[data-pfo-folder-input]').fill('Practice');
   await page.locator('[data-pfo-group-input]').fill('Evening');
   await page.locator('[data-pfo-action="save"]').click();
   await realChild.waitForFunction(async()=>{const body=await fetch('/api/songs').then(r=>r.json());const song=body.songs.find(item=>item.id==='opaque-one');return song?.identifiers?.custom?.piano_folder==='Practice'&&song?.identifiers?.custom?.piano_group==='Evening';},null,{timeout:10000});
   await page.waitForSelector('.piano-pfo-tabs [data-pfo-group="Evening"]',{timeout:10000});
   await page.waitForSelector('[data-pfo-folder="Practice"]',{timeout:10000});
   await page.locator('.piano-pfo-tabs [data-pfo-group="Evening"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===1);
   assert.equal(await page.locator('.piano-frontend-song-info strong').textContent(),'Opaque One','custom groups must filter the shared Backend library');
   await page.locator('[data-pxp-scope="all"]').click();
   await page.waitForFunction(()=>document.querySelectorAll('.piano-frontend-song').length===2);
   await page.locator('[data-pfo-action="groups"]').click();
   assert.equal(await page.locator('.piano-pfo-tabs [data-pfo-group="Evening"]').count(),1,'saved Backend group must project into custom library tabs');
   // Simulate the organizer DOM being recreated with an unchanged song catalog.
   await page.evaluate(() => {
    document.querySelector('.piano-pfo-toolbar')?.remove();
    document.querySelector('.piano-pfo-tabs')?.remove();
    window.EveAudioflixPianoFrontendOrganize.mount(document.body);
   });
   assert.equal(await page.locator('.piano-pfo-tabs [data-pfo-group="Evening"]').count(),1,'remount must rebuild group navigation from an unchanged signature');
   assert.equal(await page.locator('[data-pfo-song] option[value="opaque-one"]').count(),1,'remount must restore song selector');
   assert.equal(await page.locator('.piano-pfo-toolbar').count(),1,'remount must not duplicate organizer');

   assert.equal(await page.locator('[data-pxp-target]').count(),1,'target selector must be surfaced');
   assert.equal(await page.locator('[data-pxp-internal]').count(),1,'Internal Play must be surfaced');
   assert.equal(await page.locator('[data-pfo-player-panel]').isVisible(),false,'player tools start hidden inside frontend toolbar');
   assert.equal(await page.locator('.piano-frontend-workspace-heading').textContent(),'Piano workspace','workspace is a plain heading'); assert.equal(await page.locator('.piano-frontend-workspace-toggle').count(),0,'workspace is not collapsible'); assert.equal(await page.locator('.piano-frontend-transport').isVisible(),true,'Ready/Pause/Stop stay visible'); assert.equal(await page.locator('[data-pxp-scope="sheets"]').count(),0,'no redundant Sheets tab'); assert.equal(await page.locator('[data-pxp-scope="recordings"]').count(),0,'no redundant Recordings tab'); assert.equal(await page.locator('[data-pxp-scope="queued"]').count(),1,'Queued remains built in'); assert.equal(await page.locator('.piano-pxp-advanced').isVisible(),false,'advanced filters start in hidden Nexus panel');
   assert.equal(await page.evaluate(()=>!document.querySelector('[data-pfo-player-panel]')?.contains(document.querySelector('.piano-pxp-events'))),true,'Event view stays outside the tools drawer');
   await page.locator('[data-pfo-action="player"]').click();
   assert.deepEqual(await page.evaluate(()=>['.piano-pxp-controls','.piano-pxp-queue','.piano-pxm-listener'].map(q=>document.querySelector('[data-pfo-player-panel]')?.querySelectorAll(q).length)),[1,1,1],'Player drawer must own original setup, queue and song controls'); assert.equal(await page.locator('[data-pfo-player-panel] [data-pxp-layout]').count(),1,'backend selector is inside the header drawer');
   try { await page.waitForSelector('[data-pxp-layout] option[value="88"]',{timeout:10000,state:'attached'}); } catch(e) { throw new Error('Playback layout options unavailable: '+JSON.stringify(await page.evaluate(()=>({playerHidden:document.querySelector('[data-pfo-player-panel]')?.hidden,layoutCount:document.querySelectorAll('[data-pxp-layout]').length,options:[...document.querySelectorAll('[data-pxp-layout] option')].map(n=>n.value),portState:window.EveAudioflixPianoFrontendPorts?.snapshot?.()?.controls?.layout,bridge:window.EveAudioflixPianoFrontend?.bridgeReady?.()})))+'; '+e.message); }
   assert.equal(await page.locator('[data-pfo-player-panel]').isVisible(),true,'player tools open from header button');
   assert.equal(await page.locator('.piano-pxp-controls').getAttribute('open'),null,'Playback setup must start collapsed');
   assert.equal(await page.evaluate(()=>document.querySelector('.piano-pxp-controls')?.nextElementSibling?.classList.contains('piano-pxp-queue')),true,'Player Queue must sit directly below Playback setup');
   await page.locator('.piano-pxp-controls > summary').click();
   assert.equal(await page.locator('.piano-pxp-controls').getAttribute('open'),'','Playback setup must open when requested');
    const internalGeometry=await page.locator('.piano-pxp-toggle').evaluate(node=>{const label=node.querySelector('span').getBoundingClientRect(),toggle=node.querySelector('input').getBoundingClientRect();return{labelRight:label.right,toggleLeft:toggle.left,labelY:label.top+label.height/2,toggleY:toggle.top+toggle.height/2};});
    assert(internalGeometry.toggleLeft>=internalGeometry.labelRight-2&&internalGeometry.toggleLeft-internalGeometry.labelRight<=14&&Math.abs(internalGeometry.toggleY-internalGeometry.labelY)<12,'Internal Play toggle must sit compactly beside its label');
   await page.locator('[data-pxp-layout]').selectOption('88');
   await realChild.waitForFunction(()=>document.getElementById('pianoLayout')?.value==='88');
   assert.equal(await realChild.evaluate(()=>localStorage.getItem('eveos:piano:layout:v1')),'88');
   await page.locator('[data-pxp-sound]').selectOption('legacy_synth');
   await realChild.waitForFunction(()=>document.getElementById('pianoSound')?.value==='legacy_synth');
   assert.equal(await realChild.evaluate(()=>localStorage.getItem('eveos:piano:sound:v1')),'legacy_synth','Internal Piano Sound must persist through the Backend owner');
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
   await page.locator('.piano-pxm-editor > summary').click();
   assert.equal(await page.locator('[data-af-action="piano-frontend-media-edit-current"]').isEnabled(),true,'current library song must be available to the metadata editor');
   await page.locator('[data-af-action="piano-frontend-media-edit-current"]').click();
   assert.equal(await page.locator('[data-pxm-edit-title]').inputValue(),'Opaque One','editor must load the current Backend-owned song');
   assert.equal(await page.locator('.piano-pxm-now').getAttribute('open'),null,'song controls must start collapsed');
   await page.locator('.piano-pxm-now > summary').click();
   const trueSheetTotal=await realChild.evaluate(()=>{const el=document.getElementById('sheetInput');return window.PianoSheetProgressProjection?.buildPreview?.(el?.value,el?.dataset.timingProfile||'expressive',0,0,600)?.total;});
   assert.equal(trueSheetTotal,5,'Backend expressive event parser must define the timeline: a b c = five events including pauses');
   await page.waitForFunction(()=>document.querySelector('[data-pxm-seek-fill]')?.style.width==='0%',null,{timeout:5000});
   assert.equal(await page.locator('[data-pxm-seek-fill]').evaluate(node=>node.style.width),'0%','zero-event position must have precisely zero fill');
   await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'playing',current_index:3,total_events:5,sheet_total:5,timing_profile:'expressive',current_token:'b'}})));
   await page.waitForFunction(()=>document.querySelector('.piano-pxm-sheet-current')?.textContent==='b');
   assert.equal(await page.locator('.piano-pxm-sheet-current').textContent(),'b','Frontend sheet details must project the Backend current-event range');
   await page.locator('.piano-pxm-preview > summary').click();
   await page.waitForFunction(()=>document.querySelector('.piano-pxm-preview')?.open===true);
   await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'playing',current_index:3,total_events:5,sheet_total:5,timing_profile:'expressive',current_token:'b'}})));
   try {
     await page.waitForFunction(()=>Math.abs(parseFloat(document.querySelector('[data-pxm-seek-fill]')?.style.width)-60)<.05,null,{timeout:7000});
   } catch (error) {
     const snapshot=await page.evaluate(()=>{const s=window.EveAudioflixPianoFrontendPorts?.snapshot?.()||{};return {fill:document.querySelector('[data-pxm-seek-fill]')?.style.width,progress:s.progress,media:{status:s.media?.status,index:s.media?.index,total:s.media?.total,songId:s.media?.current?.id},range:document.querySelector('[data-pxm-seek]')?.value};});
     throw new Error(`Mid-song event 3/5 did not render 60%: ${JSON.stringify(snapshot)}; ${error.message}`);
   }
   await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'complete',current_index:5,total_events:5,sheet_total:5,timing_profile:'expressive',current_token:'c'}})));
   try {
     await page.waitForFunction(()=>document.querySelector('[data-pxm-seek-fill]')?.style.width==='100%',null,{timeout:7000});
   } catch (error) {
     const parentState=await page.evaluate(()=>{const s=window.EveAudioflixPianoFrontendPorts?.snapshot?.()||{};return {fill:document.querySelector('[data-pxm-seek-fill]')?.style.width,progress:s.progress,media:{status:s.media?.status,id:s.media?.current?.id,index:s.media?.index,total:s.media?.total}};});
     const backendState=await realChild.evaluate(()=>({player:window.PianoPlaybackOwner?.status?.(),seek:document.getElementById('eventSeekRange')?.value}));
     throw new Error(`Completion fill did not reach 100%: ${JSON.stringify({parentState,backendState})} / ${error.message}`);
   }
   assert.equal(await page.locator('[data-pxm-sheet-preview]').evaluate(el=>getComputedStyle(el).overflowY),'visible','event notation must not have nested scrolling');
    // Backend expressive timeline: 5 positions; interactive note events are 1,3,5.
    // Pause events 2 and 4 remain whitespace, never fake clickable targets.
    try {
      await page.waitForFunction(()=>{
        const notes=[...document.querySelectorAll('[data-pxm-sheet-preview] [data-pxm-event-index]')];
        return notes.map(n=>n.dataset.pxmEventIndex).join(',')==='1,3,5' &&
          notes.map(n=>n.textContent).join('')==='abc' &&
          document.querySelector('[data-pxm-sheet-preview]')?.textContent==='a b c';
      },null,{timeout:7000});
    } catch(error) {
      const projection=await page.evaluate(()=>{
        const sheet=document.querySelector('[data-pxm-sheet-preview]');
        const snap=window.EveAudioflixPianoFrontendPorts?.snapshot?.()||{};
        return {text:sheet?.textContent,
          notes:[...(sheet?.querySelectorAll('[data-pxm-event-index]')||[])].map(n=>({index:n.dataset.pxmEventIndex,text:n.textContent})),
          mediaEvents:snap.media?.sheetEvents,progressEvents:snap.progress?.sheetEvents,
          mediaId:snap.media?.current?.id,status:snap.progress?.status};
      });
      throw new Error(`Expected Backend-mapped note targets 1,3,5 (pauses are text): ${JSON.stringify(projection)}; ${error.message}`);
    }
    assert.deepEqual(await page.locator('[data-pxm-sheet-preview] [data-pxm-event-index]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.pxmEventIndex))),[1,3,5],'only notes, not whitespace pauses, are clickable');
    // Verify both the emitted intent AND the authoritative Backend reply.
    // These are serialized mutations: issuing another seek or a metadata save
    // before the previous reply could spuriously reject the next command.
    await page.evaluate(()=>{
      const p=window.EveAudioflixPianoFrontendPorts,orig=p.command;
      window.__eventSeekCommands=[];window.__seekAcks=[];
      p.command=function(action,fields){if(action==='progress:seek')window.__eventSeekCommands.push({...fields});return orig.apply(this,arguments);};
      window.addEventListener('message',event=>{const d=event.data;
        if(d?.type==='piano:eveos-frontend-port-response'&&d.action==='progress:seek')
          window.__seekAcks.push({error:d.error||''});
      });
    });
    await page.locator('[data-pxm-event-index="3"]').click();
   assert.deepEqual(await page.evaluate(()=>window.__eventSeekCommands),[{eventIndex:3}],'event click must send one exact Backend seek');
    await page.waitForFunction(()=>window.__seekAcks?.length===1,null,{timeout:10000});
    assert.deepEqual(await page.evaluate(()=>window.__seekAcks),[{error:''}],'mouse event seek must be accepted by Backend');
   await page.locator('[data-pxm-event-index="1"]').focus();
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.pxmEventIndex),'1','keyboard target must receive focus');
   await page.keyboard.press('Enter');
    try {
      await page.waitForFunction(()=>window.__eventSeekCommands?.length===2,null,{timeout:3500});
    } catch(error) {
      const parent=await page.evaluate(()=>({active:document.activeElement?.outerHTML?.slice(0,300),
        notes:[...document.querySelectorAll('[data-pxm-sheet-preview] [data-pxm-event-index]')].map(n=>({index:n.dataset.pxmEventIndex,focused:document.activeElement===n})),
        calls:window.__eventSeekCommands,progress:window.EveAudioflixPianoFrontendPorts?.snapshot?.()?.progress}));
      throw new Error(`Keyboard Enter did not dispatch one seek: ${JSON.stringify(parent)}; ${error.message}`);
    }
    assert.deepEqual(await page.evaluate(()=>window.__eventSeekCommands),[{eventIndex:3},{eventIndex:1}],'keyboard event seek must send exactly one correct command');
    await page.waitForFunction(()=>window.__seekAcks?.length===2,null,{timeout:10000});
    assert.deepEqual(await page.evaluate(()=>window.__seekAcks),[{error:''},{error:''}],'keyboard event seek must be accepted by Backend');
    assert.equal(await page.locator('[data-pxm-sheet-preview]').evaluate(node=>getComputedStyle(node).overflowY),'visible','Song & sheet details must expand without a nested scrollbar');
    // This loaded sheet has five Backend events, not the 100-event fixture
    // from older tests. Clear the preceding note-click seek hold by acknowledging
    // event 1, then exercise progress and drag only within valid positions.
    await page.waitForFunction(()=>window.EveAudioflixPianoFrontend?.pendingCount?.()===0,null,{timeout:8000});
    await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'playing',current_index:1,total_events:5,sheet_total:5,timing_profile:'expressive',current_token:'a'}})));
    await page.waitForFunction(()=>document.querySelector('[data-pxm-seek]')?.value==='1',null,{timeout:8000});
    await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'playing',current_index:3,total_events:5,sheet_total:5,timing_profile:'expressive',current_token:'b'}})));
    try {
      await page.waitForFunction(()=>document.querySelector('[data-pxm-seek]')?.value==='3',null,{timeout:8000});
    } catch(error) {
      const parent=await page.evaluate(()=>{const snap=window.EveAudioflixPianoFrontendPorts?.snapshot?.()||{};return {seek:document.querySelector('[data-pxm-seek]')?.value,fill:document.querySelector('[data-pxm-seek-fill]')?.style.width,progress:snap.progress,media:{id:snap.media?.current?.id,index:snap.media?.index,total:snap.media?.total,status:snap.media?.status}};});
      const backend=await realChild.evaluate(()=>({status:window.PianoPlaybackOwner?.status?.(),seek:document.getElementById('eventSeekRange')?.value}));
      throw new Error(`Valid same-song index 3 did not project: ${JSON.stringify({parent,backend})}; ${error.message}`);
    }
    await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'playing',current_index:0,total_events:5,sheet_total:5,timing_profile:'expressive',current_token:''}})));
    assert.equal(await page.locator('[data-pxm-seek]').inputValue(),'3','transient active zero progress must not reset the same-song timeline');
    await page.locator('[data-pxm-seek]').evaluate(node=>{node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));node.value='4';node.dispatchEvent(new Event('input',{bubbles:true}));});
    await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'playing',current_index:2,total_events:5,sheet_total:5,timing_profile:'expressive',current_token:' '}})));
    assert.equal(await page.locator('[data-pxm-seek]').inputValue(),'4','live progress must not fight the user while the seek thumb is being dragged');
    await page.locator('[data-pxm-seek]').dispatchEvent('change');
    assert.deepEqual(await page.evaluate(()=>window.__eventSeekCommands.slice(-1)),[{eventIndex:4}],'seek drag must send the Backend exactly one correct event');
    await page.waitForFunction(()=>window.__seekAcks?.length===3,null,{timeout:10000});
    assert.deepEqual(await page.evaluate(()=>window.__seekAcks),[{error:''},{error:''},{error:''}],'drag seek must be accepted by Backend');
    await realChild.evaluate(()=>window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',{detail:{status:'playing',current_index:4,total_events:5,sheet_total:5,timing_profile:'expressive',current_token:' '}})));
    await page.waitForFunction(()=>document.querySelector('[data-pxm-seek]')?.value==='4',null,{timeout:8000});
   await page.locator('.piano-pxm-history > summary').click();
   await page.waitForFunction(()=>document.querySelectorAll('[data-pxm-history-list] button').length===1);
   const favoriteBefore=await page.locator('[data-af-action="piano-frontend-media-current-favorite"]').textContent();
   assert(favoriteBefore.includes('☆'),`Piano fixture must begin unfavorited; got ${JSON.stringify(favoriteBefore)}`);
   // Capture the metadata-save acknowledgement and its subsequent library repaint.
   await page.evaluate(()=>{
     window.__favoriteSync={updated:false,refreshed:false,error:''};
     window.addEventListener('message',event=>{
       const d=event.data,s=window.__favoriteSync;
       if(d?.type==='piano:eveos-frontend-port-response'&&d.action==='song:update'){s.updated=true;s.error=d.error||'';}
       else if(d?.type==='piano:eveos-frontend-response'&&Array.isArray(d.songs)&&s.updated&&!s.error)
         s.refreshed=d.songs.some(song=>song.id==='opaque-one'&&song.identifiers?.custom?.favorite==='true');
     });
   });
   await page.locator('[data-af-action="piano-frontend-media-current-favorite"]').click();
   const favoriteAfter=await page.locator('[data-af-action="piano-frontend-media-current-favorite"]').textContent();
   if(!favoriteAfter.includes('★')){
     const diagnostics=await page.evaluate(()=>{const s=window.EveAudioflixPianoFrontendPorts?.snapshot?.()||{};
       const current=s.media?.current||{},song=window.EveAudioflixPianoFrontend?.getSongs?.()?.find(x=>x.id===current.id);
       return {button:document.querySelector('[data-af-action="piano-frontend-media-current-favorite"]')?.outerHTML,
         currentId:current.id,mediaFavorite:current.identifiers?.custom?.favorite,
         libraryFavorite:song?.identifiers?.custom?.favorite,
         seekReplies:window.__seekAcks,seekCommands:window.__eventSeekCommands,
         portNotice:document.querySelector('[data-pxp-notice]')?.textContent,
         frontendPending:window.EveAudioflixPianoFrontend?.pendingCount?.()};
     });
     throw new Error(`Favorite control must update optimistically on same click: before=${JSON.stringify(favoriteBefore)} after=${JSON.stringify(favoriteAfter)} diagnostics=${JSON.stringify(diagnostics)}`);
   }
   await realChild.waitForFunction(async()=>{const response=await fetch('/api/songs');const body=await response.json();return body.songs?.find(song=>song.id==='opaque-one')?.identifiers?.custom?.favorite==='true';});
   await page.waitForFunction(()=>document.querySelector('[data-af-action="piano-frontend-media-current-favorite"]')?.textContent.includes('★'));
    await page.waitForFunction(()=>window.__favoriteSync?.refreshed===true,null,{timeout:10000});
   assert.deepEqual(await page.evaluate(()=>window.__favoriteSync),{updated:true,refreshed:true,error:''},'metadata save and library refresh must finish before queue-only DOM checks');
   await page.waitForFunction(()=>window.EveAudioflixPianoFrontend?.pendingCount?.()===0);
   await realChild.evaluate(()=>window.parent.postMessage({type:'piano:eveos-port-update',queue:{mode:'ordered',currentId:'q2',items:[{queueId:'q1',songId:'one',label:'Played One'},{queueId:'q2',songId:'two',label:'Current Two'},{queueId:'q3',songId:'three',label:'Next Three'}]}},'*'));
   await page.waitForFunction(()=>document.querySelector('[data-pxp-next]')?.textContent==='Next Three');
   // Observe whether an unrelated library refresh, rather than a queue update, replaces rows.
   await page.evaluate(()=>{window.__queueRowEvents=[];
     new MutationObserver(rs=>{if(rs.some(r=>r.type==='childList'))window.__queueRowEvents.push('song-list-replaced');})
       .observe(document.querySelector('[data-pf-songs]'),{childList:true});
     window.addEventListener('message',e=>{if(e.data?.type==='piano:eveos-frontend-response'&&Array.isArray(e.data.songs))window.__queueRowEvents.push('library-response');});
   });
   await page.evaluate(()=>{window.__stablePianoSongRow=document.querySelector('.piano-frontend-song[data-song-id="opaque-one"]');});
   await page.locator('[data-af-action="piano-frontend-port-queue-add"][data-song-id="opaque-one"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.some(item=>item.songId==='opaque-one'));
   await page.waitForFunction(()=>document.querySelector('[data-pxp-queue-count]')?.textContent==='1 queued');
   const rowIdentity=await page.evaluate(()=>({same:document.querySelector('.piano-frontend-song[data-song-id="opaque-one"]')===window.__stablePianoSongRow,events:window.__queueRowEvents}));
   assert(rowIdentity.same,`queue update must preserve song-row identity: ${JSON.stringify(rowIdentity)}`);
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
   await page.locator('[data-pfo-action="nexus"]').click();
   assert.equal(await page.locator('[data-pfo-player-panel]').isVisible(),false,'Nexus opens exclusively');
   assert.deepEqual(await page.evaluate(()=>['genre','author','source','tags','rating','duration','events'].map(k=>document.querySelectorAll('[data-pxp-'+k+']').length)),[1,1,1,1,1,1,1],'filters must have one live input each'); assert.equal(await page.locator('.piano-pxp-pills').count(),1,'built-in tabs must not duplicate after late filter recovery'); assert.equal(await page.locator('[data-pfo-search-panel] .piano-pxp-advanced').count(),1,'advanced filters are owned by Nexus'); await page.locator('[data-pfo-search-panel] .piano-pxp-advanced > summary').click();
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
    await page.locator('.piano-pxp-events > summary').click();
    assert.equal(await page.locator('[data-pxp-event-seek]').count(),9,'Event view must port the complete Backend navigation control set');
    assert.equal(await page.locator('[data-pxp-event-input]').inputValue(),'3');
    assert.equal(await page.locator('[data-pxp-event-input]').getAttribute('max'),'12');
    try {
      await page.waitForFunction(()=>document.querySelector('[data-pxp-event-seek="start"]')?.disabled===false,null,{timeout:8000});
    } catch(error) {
      const state=await page.evaluate(()=>({
        view:document.querySelector('[data-audioflix-piano]')?.dataset.pianoView,
        running:document.querySelector('[data-audioflix-piano]')?.dataset.running,
        bridge:window.EveAudioflixPianoFrontend?.bridgeReady?.(),
        progress:window.EveAudioflixPianoFrontendPorts?.snapshot?.()?.progress,
        button:document.querySelector('[data-pxp-event-seek="start"]')?.outerHTML
      }));
      throw new Error(`Event navigation did not become active: ${JSON.stringify(state)}; ${error.message}`);
    }
    await page.locator('[data-pxp-event-seek="start"]').click();
    await realChild.waitForFunction(()=>document.getElementById('eventSeekRange')?.value==='1');
   await realChild.evaluate(() => window.dispatchEvent(new CustomEvent('piano:sheet-progress-status',
     { detail: { status:'playing', current_index:0, total_events:12, current_token:'a' } })));
   await page.waitForFunction(() => document.querySelector('[data-pxp-event-count]')?.textContent === '0 / 12 events');
   assert.equal(await page.locator('[data-pxp-event-rail]').getAttribute('aria-valuenow'),'0','new-song progress must not retain a stale nonzero index');
   if (await page.locator('[data-pfo-player-panel]').isHidden()) await page.locator('[data-pfo-action="player"]').click();
   await page.locator('[data-af-action="piano-frontend-port-queue-clear"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.length===0);
   await realChild.evaluate(()=>window.PianoPlayerQueue.addSong({id:'opaque-two',title:'Opaque Two',sheet:'d e f'},false));
   await page.waitForFunction(()=>document.querySelector('[data-pxp-queue-count]')?.textContent==='1 queued');
   assert.equal(await page.locator('.piano-frontend-song[data-song-id="opaque-two"] [data-pxp-queued-count]').textContent(),'1 queued','Backend queue mutations must project into the same Frontend queue state');
    await page.locator('[data-pxp-internal]').check();
    await realChild.evaluate(()=>{const countdown=document.getElementById('countdownRange');countdown.value='0';countdown.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await realChild.evaluate(()=>typeof window.PianoPlaybackOwner?.playSong),'function','Backend must expose one playback owner to its queue and Frontend ports');
    // Queue song d e f was too short for a DOM statusChip check, which is updated
    // on a separate poll. Retain the same song ID and use the Backend library.
    const queueSheet='d e f '.repeat(135).trim();
    const queueFixture=await realChild.evaluate(async sheet=>{
      // Player Queue imports the same /assets/api.js module and reads api.songs().
      // Raw fetch POST bypasses its cache invalidation and falsely tests a 5-event song.
      const {api}=await import('/assets/api.js');
      const saved=await api.saveSong({id:'opaque-two',title:'Opaque Two',sheet});
      const fresh=await api.songs({fresh:true});
      const cached=await api.songs();
      const find=body=>body.songs?.find(song=>song.id==='opaque-two')?.sheet?.length;
      return {id:saved.song?.id,length:saved.song?.sheet?.length,freshLength:find(fresh),cachedLength:find(cached)};
    },queueSheet);
    assert.equal(queueFixture.id,'opaque-two','long queue fixture must keep the same Backend library ID');
    assert.equal(queueFixture.length,queueSheet.length,'Backend must retain the complete queue test fixture');
    assert.equal(queueFixture.freshLength,queueSheet.length,'queue fixture must be visible to fresh Backend library reads');
    assert.equal(queueFixture.cachedLength,queueSheet.length,'Player Queue cached song library must contain long test fixture before Play');
    await page.evaluate(()=>{window.__queueStartReplies=[];window.addEventListener('message',event=>{
      const d=event.data;if(d?.type==='piano:eveos-frontend-port-response'&&d.action==='queue:play')
        window.__queueStartReplies.push({error:d.error||''});
    });});
    await page.locator('[data-af-action="piano-frontend-port-queue-play"]').click();
    try {
      await page.waitForFunction(()=>window.__queueStartReplies?.length===1,null,{timeout:12000});
      assert.deepEqual(await page.evaluate(()=>window.__queueStartReplies),[{error:''}],'queue start must receive one successful Backend reply');
      await realChild.waitForFunction(()=>{
        const q=window.PianoPlayerQueue?.getState?.(),p=window.PianoPlaybackOwner?.status?.();
        return q?.active===true&&p?.internal_preview===true&&p.total_events>500&&['countdown','playing'].includes(p.status);
      },null,{timeout:10000});
      await page.waitForFunction(()=>document.querySelector('[data-af-action="piano-frontend-port-queue-play"]')?.textContent==='Playing queue',null,{timeout:10000});
    } catch(error) {
      const backend=await realChild.evaluate(()=>({status:window.PianoPlaybackOwner?.status?.(),queue:window.PianoPlayerQueue?.getState?.(),chip:document.getElementById('statusChip')?.dataset.state}));
      const frontend=await page.evaluate(()=>({replies:window.__queueStartReplies,queueButton:document.querySelector('[data-af-action="piano-frontend-port-queue-play"]')?.outerHTML,
        projection:window.EveAudioflixPianoFrontendPorts?.snapshot?.()?.progress}));
      throw new Error(`Long Internal Play queue start failed: ${JSON.stringify({backend,frontend})}; ${error.message}`);
    }
    await page.locator('[data-af-action="piano-frontend-port-queue-stop"]').click();
    await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().active===false);
    await page.waitForFunction(()=>document.querySelector('[data-af-action="piano-frontend-port-queue-play"]')?.textContent!=='Playing queue');
   await page.locator('[data-af-action="piano-frontend-port-queue-clear"]').click();
   await realChild.waitForFunction(()=>window.PianoPlayerQueue?.getState?.().items?.length===0);
   assert.equal(await realChild.evaluate(()=>window.__eveosPianoFrontendPortReady),true,'existing playback port must survive');
    await assertTransportContinuity(page,realChild);
   console.log(`PIANO_FRONTEND_PORTS_REAL_APP_OK origin=file targets=PASS internal=PASS layout=PASS sound=PASS metadata=PASS scope=PASS queue=PASS queue-sync=PASS module-retry=PASS layout-order=PASS events=PASS`);
   console.log(`PIANO_FRONTEND_OPAQUE_REAL_APP_OK origin=file library=PASS bridge=PASS controls=PASS announcements=${bridgeEvidence.announcements}`);
  } catch (error) {
    throw new Error(`${error.stack || error.message}\nReal Piano browser console:\n${consoleLines.slice(-40).join(' | ')}\nReal Piano page errors:\n${pageErrors.slice(-20).join(' | ')}`);
  } finally { await page.close(); }
 } catch (error) { throw new Error(`${error.message}\nPiano server stderr:\n${stderr}`); }
 finally { child.kill(); fs.rmSync(temp,{recursive:true,force:true}); }
}

module.exports = { opaqueRealAppTest };
