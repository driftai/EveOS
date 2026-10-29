'use strict';
const assert = require('node:assert/strict');

async function assertTransportContinuity(page, realChild) {
  const songPlay=page.locator('.piano-frontend-song[data-song-id="opaque-one"] .piano-frontend-song-play');
  await realChild.waitForFunction(()=>window.PianoPlaybackOwner?.status?.().status==='idle',null,{timeout:10000});
  try {
    await page.waitForFunction(()=>{
      const b=document.querySelector('.piano-frontend-song[data-song-id="opaque-one"] .piano-frontend-song-play');
      return b?.dataset.afAction==='piano-frontend-play'&&b?.disabled===false&&b.textContent==='Play';
    },null,{timeout:8000});
  } catch (error) {
    const owner=await realChild.evaluate(()=>({status:window.PianoPlaybackOwner?.status?.(),queue:window.PianoPlayerQueue?.getState?.()}));
    const projection=await page.evaluate(()=>{const b=document.querySelector('.piano-frontend-song[data-song-id="opaque-one"] .piano-frontend-song-play'),s=window.EveAudioflixPianoFrontendPorts?.snapshot?.()||{};
      return {button:b?.outerHTML,progress:s.progress,media:{id:s.media?.current?.id,status:s.media?.status}};});
    throw new Error(`Queue stop must reconcile row to Play: ${JSON.stringify({owner,projection})}; ${error.message}`);
  }
  const expandedSheet='a b c '.repeat(130).trim();
  const updatedSong=await realChild.evaluate(async sheet=>{
    const {api}=await import('/assets/api.js');
    const saved=await api.saveSong({id:'opaque-one',title:'Opaque One',sheet});
    const cached=await api.songs();
    return {id:saved.song?.id,length:saved.song?.sheet?.length,cachedLength:cached.songs?.find(song=>song.id==='opaque-one')?.sheet?.length};
  },expandedSheet);
  assert.equal(updatedSong.id,'opaque-one','test fixture must update the same Backend library song');
  assert.equal(updatedSong.length,expandedSheet.length,'long-playing test fixture must retain all notes');
  assert.equal(updatedSong.cachedLength,expandedSheet.length,'Backend cached library must expose extended song to normal Play');
  await songPlay.click();
  await realChild.waitForFunction(()=>{
    const p=window.PianoPlaybackOwner?.status?.();return p?.internal_preview===true&&p.total_events>500&&['countdown','playing'].includes(p.status);
  },null,{timeout:10000});
  await page.waitForFunction(()=>document.querySelector('.piano-frontend-song[data-song-id="opaque-one"] .piano-frontend-song-play')?.textContent==='Stop',null,{timeout:10000});

  const beforeInstrument=await realChild.evaluate(()=>window.PianoPlaybackOwner.status());
  await page.locator('[data-pxp-sound]').selectOption('bright_acoustic');
  await realChild.waitForFunction(index=>{
    const p=window.PianoPlaybackOwner.status();return ['playing','countdown'].includes(p.status)&&p.current_index>index;
  },beforeInstrument.current_index,{timeout:5000});
  assert.equal(await page.locator('[data-pxm-compact-pause]').isEnabled(),true,'instrument hot-swap must preserve the shared Pause/Resume transport');
  const beforeLayout=await realChild.evaluate(()=>window.PianoPlaybackOwner.status());
  await page.locator('[data-pxp-layout]').selectOption('88');
  await realChild.waitForFunction(index=>{
    const p=window.PianoPlaybackOwner.status();return ['playing','countdown'].includes(p.status)&&p.current_index>index;
  },beforeLayout.current_index,{timeout:5000});

  const compactPause=page.locator('[data-pxm-compact-pause]');
  await page.waitForFunction(()=>window.EveAudioflixPianoFrontend?.pendingCount?.()===0,null,{timeout:10000});
  await compactPause.click();
  await realChild.waitForFunction(()=>window.PianoPlaybackOwner.status().status==='paused',null,{timeout:10000});
  await page.waitForFunction(()=>document.querySelector('[data-pxm-compact-pause]')?.textContent==='Resume',null,{timeout:10000});
  const pausedAt=await realChild.evaluate(()=>window.PianoPlaybackOwner.status());
  assert.equal(pausedAt.current_index>=beforeInstrument.current_index,true,'pause cannot rewind');
  await compactPause.click();
  await realChild.waitForFunction(()=>['playing','countdown'].includes(window.PianoPlaybackOwner.status().status),null,{timeout:10000});
  await page.waitForFunction(()=>document.querySelector('[data-pxm-compact-pause]')?.textContent==='Pause',null,{timeout:10000});
  const unchangedQueue=await realChild.evaluate(()=>window.PianoPlayerQueue.getState());
  await compactPause.click();
  await realChild.waitForFunction(()=>window.PianoPlaybackOwner.status().status==='paused',null,{timeout:10000});
  const beforeSwitch=await realChild.evaluate(()=>window.PianoPlaybackOwner.status());
  await page.evaluate(()=>{window.__transitionCalls=[];const p=window.EveAudioflixPianoFrontendPorts;const original=p.command;p.command=function(action,fields){window.__transitionCalls.push(action);return original.apply(this,arguments);};});
  await page.locator('[data-af-action="piano-frontend-media-edit-backend"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-audioflix-piano]')?.dataset.pianoView==='backend');
  assert.deepEqual(await page.evaluate(()=>window.__transitionCalls.filter(x=>x==='song:load'||x.startsWith('queue:')||x==='progress:seek')),[],'Edit in Backend must emit no load/queue/seek command');
  assert.equal(await realChild.evaluate(()=>window.PianoPlayerQueue.getState().currentId),unchangedQueue.currentId,'view switch must preserve queue entry');
  assert.equal(await realChild.evaluate(()=>document.getElementById('internalPlay').checked),true,'view switch must preserve Internal Play');
  const afterSwitch=await realChild.evaluate(()=>window.PianoPlaybackOwner.status());
  assert.equal(afterSwitch.status,'paused','Edit in Backend must preserve paused playback');
  assert.equal(afterSwitch.current_index,beforeSwitch.current_index,'Edit in Backend must preserve paused event position');
  await page.click('[data-piano-view-switch]');
  await compactPause.click();
  await realChild.waitForFunction(()=>['playing','countdown'].includes(window.PianoPlaybackOwner.status().status),null,{timeout:10000});
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
  assert.equal(await realChild.evaluate(()=>document.getElementById('internalPlay').checked),true,'Internal Play must restore after reload');
  await page.click('[data-piano-view-switch]');
  await page.waitForFunction(()=>window.EveAudioflixPianoFrontend?.bridgeReady?.()===true,null,{timeout:10000});
  assert.match(await page.locator('[data-piano-frame]').getAttribute('allow'),/\bautoplay\b/,'Piano iframe must receive autoplay delegation for restored Internal Play');
  assert.equal(await page.evaluate(()=>window.EveAudioflixPianoFrontendPorts.command('song:load',{songId:'opaque-one'})),true,'Frontend command port must accept work after Backend Refresh');
  await realChild.waitForFunction(()=>document.getElementById('titleInput')?.value.includes('Opaque One'),null,{timeout:10000});
  await page.waitForFunction(()=>document.querySelector('[data-pxm-current]')?.textContent==='Opaque One',null,{timeout:10000});
  await page.locator('.piano-frontend-song[data-song-id="opaque-one"] .piano-frontend-song-play').click();
  await realChild.waitForFunction(()=>window.PianoPlaybackOwner?.status?.().internal_preview===true&&['countdown','playing'].includes(window.PianoPlaybackOwner.status().status),null,{timeout:10000});
}

module.exports={assertTransportContinuity};
