function currentPosition() { return mediaVideo ? (mediaVideo.currentTime || 0) : (ytPlayer?.getCurrentTime?.() || 0); }
async function command(type, extra={}) { const sentAt=Date.now();const measuredRtt=window.watchPartyClock?.rttMs?.();const sampledServerAt=Number.isFinite(measuredRtt)?estimatedServerNow():null;const payload=sampledServerAt==null?{type,...extra}:{type,...extra,sampledServerAt};const res=await fetch(apiUrl(`/api/rooms/${roomId}/command`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify(payload)});const receivedAt=Date.now();const data=await res.json().catch(()=>({}));if(data.state?.serverTime)updateServerClock(data.state.serverTime,sentAt,receivedAt);if(!res.ok){setStatus(data.error||'Command rejected');return false;}if(data.state&&applyIncomingRoomState(data.state)){render();if(data.state.source?.kind==='media')window.mediaPlayback?.sync?.();else syncPlayer();}return true; }
function soloPlaybackState(){return{paused:true,ended:false,position:0,rate:1,updatedAt:Date.now()};}
function applySoloSource(source){state={source,playback:soloPlaybackState(),members:[],messages:[],revision:0};sourceInputDirty=false;const hasActive=source&&source.kind!=='ready';if($('mediaStage'))$('mediaStage').classList.toggle('media-stage-empty',!hasActive);if($('partyDetails'))$('partyDetails').hidden=true;if($('partyPanel'))$('partyPanel').hidden=true;if($('syncBtn'))$('syncBtn').hidden=true;if($('copyBtn'))$('copyBtn').hidden=true;if($('leaveRoomBtn'))$('leaveRoomBtn').hidden=true;if($('deleteRoomBtn'))$('deleteRoomBtn').hidden=true;render();}
async function promoteCurrentSourceToRoom(){const source=state?.source;if(!roomId||!session||!source)return true;if(source.kind==='live'){await window.watchFusionLive.share(source);return true;}if(source.videoId||source.kind==='youtube'||source.type==='youtube'){const ok=await command('source',{input:source.originalUrl||source.videoId});if(!ok)throw new Error('Could not promote YouTube into the room.');return true;}const res=await fetch(apiUrl(`/api/rooms/${roomId}/media-source`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify({media:source,originalUrl:source.originalUrl||source.url})});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'Could not promote the current media into the room.');state=data.state;return true;}
$('createBtn').onclick=async()=>{await networkInfoReady;const name=$('nameInput').value.trim()||'Guest';const requested=$('roomInput').value.trim().toUpperCase();const id=requested||makeRoomId();if(!/^[A-Z0-9_-]{3,32}$/.test(id))return alert('Enter a valid room number or room ID');const sourceBeforeRoom=state?.source?{...state.source}:null;setName(name);try{const res=await fetch(apiUrl(`/api/rooms/${encodeURIComponent(id)}/create`),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,accountId,roomCode:/^[0-9]{1,12}$/.test(id)?id:undefined})});const data=await res.json().catch(()=>({}));if(!res.ok)return alert(data.error||'Could not create room');await join(data.roomId,name,data.roomCode||null);if(sourceBeforeRoom){state.source=sourceBeforeRoom;await promoteCurrentSourceToRoom();render();}if($('lobby'))$('lobby').hidden=true;setHeaderExpanded(false);}catch(error){alert(error?.message||'Could not create room');}};
$('joinBtn').onclick=()=>{const id=$('roomInput').value.trim();const name=$('nameInput').value.trim()||'Guest';if(!/^[A-Za-z0-9_-]{3,32}$/.test(id))return alert('Enter the room number or encoded room ID');join(id,name);};
function updateSourceInputButton(){const btn=$('loadBtn');if(btn)btn.textContent='Find / Load';}
$('sourceInput').addEventListener('input',()=>{sourceInputDirty=true;updateSourceInputButton();});
$('loadBtn').onclick=async()=>{
  if(roomId&&!isHost())return alert('Only the host can load video sources.');
  const input=$('sourceInput').value.trim();
  if(!input)return alert('Paste a YouTube URL, direct video/HLS URL, or supported watch-page URL.');
  if(/^(?:nuvio:\/\/|stremio:\/\/|tt\d{7,10}$)/i.test(input))return openNuvioBrowserMode();
  await window.watchFusionMediaResolver?.resolve?.({input,autoLoad:false});
};
function showFindMedia(){if($('findMediaPanel'))$('findMediaPanel').hidden=false;if($('soloEmptyState'))$('soloEmptyState').hidden=true;document.querySelectorAll('.source-tab').forEach(tab=>tab.classList.toggle('active',tab.id==='resolveTabBtn'));if($('sourceModeLabel'))$('sourceModeLabel').textContent='Ready';$('sourceInput')?.focus();}
function showNuvio(){if($('findMediaPanel'))$('findMediaPanel').hidden=true;openNuvioBrowserMode();}
function showVoxelVision(){if($('findMediaPanel'))$('findMediaPanel').hidden=true;openVoxelVisionMode();}
$('shortcutNuvioBtn').onclick=null;
$('shortcutNuvioBtn').addEventListener('click',showNuvio,true);
$('shortcutNuvioBtn').__watchFusionHostInputBound=true;
$('shortcutVoxelVisionBtn').onclick=null;
$('shortcutVoxelVisionBtn').addEventListener('click',showVoxelVision,true);
$('shortcutVoxelVisionBtn').__watchFusionHostInputBound=true;
$('resolveTabBtn').onclick=null;
$('resolveTabBtn').addEventListener('click',showFindMedia,true);
$('resolveTabBtn').__watchFusionHostInputBound=true;
// Source-tab activation is handled by the element-level click listeners above.
// The scoped host compatibility layer (watchfusion-host-input-fix.js) covers
// pointerdown-first fallback for #shortcutNuvioBtn and #resolveTabBtn only.
// Do NOT install a global window pointerdown capture here — it would block the
// normal WatchFusion DOM event system for all other interactive elements.
window.openNuvioBrowserMode = openNuvioBrowserMode;
window.openVoxelVisionMode = openVoxelVisionMode;
async function unloadWatchFusionMedia(){
  if(window.watchFusionLinkedTab?.active?.())await window.watchFusionLinkedTab.stop({quiet:true});
  const source=state?.source;if(!source||source.kind==='ready')return true;
  if(roomId&&!isHost()){setStatus('Only the host can unload the room media.');return false;}
  try{
    await window.watchPartyProviders?.unload?.(source);
    window.mediaPlayback?.clear?.();
    if(source.videoId||source.kind==='youtube'||source.type==='youtube'){try{ytPlayer?.stopVideo?.();}catch{}pendingVideoId=null;playerInitializing=false;}
    const ready={kind:'ready',type:'ready',title:'Ready'};
    if(roomId){const ok=await command('source',{source:ready});if(!ok)return false;}
    else applySoloSource(ready);
    sourceInputDirty=false;if($('sourceInput'))$('sourceInput').value='';
    if($('livePairHelp'))$('livePairHelp').hidden=true;
    setStatus('Media unloaded');render();return true;
  }catch(error){setStatus(error?.message||'Could not unload media.');return false;}
}
window.unloadWatchFusionMedia=unloadWatchFusionMedia;
$('closeFindMediaBtn').onclick=()=>{if($('findMediaPanel'))$('findMediaPanel').hidden=true;render();};
$('unloadMediaBtn').onclick=()=>{void unloadWatchFusionMedia();};
$('syncBtn').onclick=()=>{if(!roomId)return;if(state?.source?.kind==='media')window.mediaPlayback?.sync?.({force:true});else syncPlayer({force:true});};$('copyBtn').onclick=async()=>{const link=shareRoomLink();if(!link)return;const copied=await copyText(link);setCopyButtonFeedback($('copyBtn'),copied,'Copy room link');setStatus(copied?'Shareable room link copied':link);};$('roomPill').onclick=copyJoinCode;$('copyLanBtn').onclick=async()=>{if(!roomId||!session){updateLanCopyVisibility();return;}let link=lanRoomLink();if(!link){await loadNetworkInfo().catch(()=>{});link=lanRoomLink();}if(!link){updateLanCopyVisibility();return setStatus('LAN share address is still resolving');}const copied=await copyText(link);setCopyButtonFeedback($('copyLanBtn'),copied,'Copy LAN link');setStatus(copied?'LAN room link copied':link);};$('leaveRoomBtn').onclick=async()=>{if(!roomId||!session)return;const leavingRoom=roomId,memberId=session.memberId;try{await fetch(apiUrl(`/api/rooms/${encodeURIComponent(leavingRoom)}/leave`),{method:'POST',headers:{'x-member-id':memberId},cache:'no-store'});}catch{}leaveRoom('Left room.');};$('deleteRoomBtn').onclick=async()=>{if(!isHost())return;if(!confirm('Delete this room for everyone?'))return;const ok=await command('delete-room');if(ok)leaveRoom('Room deleted.');};
async function sendChatMessage(){const input=$('chatInput');const submit=$('chatForm')?.querySelector('button[type="submit"],button:not([type])');const text=input?.value.trim();if(!text||!roomId||!session)return;if(submit)submit.disabled=true;try{const ok=await command('chat',{text});if(ok){input.value='';setStatus(text.length>500?`Prompt sent · ${text.length.toLocaleString()} characters`:'Message sent');}}catch{setStatus('Connection failed · message kept for retry');}finally{if(submit)submit.disabled=false;input?.focus();}}
function imageTypeForFile(file){if(['image/jpeg','image/png','image/webp','image/gif'].includes(file?.type))return file.type;const extension=String(file?.name||'').toLowerCase().match(/\.(jpe?g|png|webp|gif)$/)?.[1];return extension==='jpg'||extension==='jpeg'?'image/jpeg':extension?`image/${extension}`:'';}
async function sendChatImage(file){const button=$('chatImageBtn');if(!file||!roomId||!session)return;const type=imageTypeForFile(file);if(!type)return setStatus('Choose a JPEG, PNG, WebP, or GIF image');if(file.size>12*1024*1024)return setStatus('Image is larger than 12 MB');button.disabled=true;setStatus(`Sending ${file.name||'pasted image'}…`);try{const res=await fetch(apiUrl(`/api/rooms/${encodeURIComponent(roomId)}/attachments`),{method:'POST',headers:{'Content-Type':type,'x-member-id':session.memberId,'x-file-name':encodeURIComponent(file.name||'pasted-image')},body:file});const data=await res.json().catch(()=>({}));if(!res.ok)return setStatus(data.error||'Image could not be sent');if(data.state){state=data.state;render();}setStatus(`Image sent · ${(file.size/1024/1024).toFixed(1)} MB`);}catch{setStatus('Connection failed · image not sent');}finally{button.disabled=false;$('chatImageInput').value='';}}
function pastedImagePath(value){const clean=String(value||'').trim().replace(/^["']|["']$/g,'');return /^(?:file:\/\/\/|[A-Za-z]:[\\/]|\/).+\.(?:jpe?g|png|webp|gif)$/i.test(clean)?clean:'';}
async function sendChatImagePath(imagePath){const button=$('chatImageBtn');if(!imagePath||!roomId||!session)return;button.disabled=true;setStatus('Reading local image path…');try{const res=await fetch(apiUrl(`/api/rooms/${encodeURIComponent(roomId)}/attachments/path`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify({path:imagePath})});const data=await res.json().catch(()=>({}));if(!res.ok)return setStatus(data.error||'Local image path could not be sent');if(data.state){state=data.state;render();}setStatus('Local image sent');}catch{setStatus('Connection failed · local image not sent');}finally{button.disabled=false;}}
$('chatForm').onsubmit=e=>{e.preventDefault();sendChatMessage();};
$('chatInput').addEventListener('keydown',e=>{if(e.key!=='Enter'||e.shiftKey||e.isComposing)return;e.preventDefault();e.currentTarget.form?.requestSubmit();});
$('chatImageBtn').onclick=()=>$('chatImageInput').click();
$('chatImageInput').addEventListener('change',e=>sendChatImage(e.currentTarget.files?.[0]));
$('chatInput').addEventListener('paste',e=>{const image=[...(e.clipboardData?.items||[])].filter(item=>item.kind==='file').map(item=>item.getAsFile?.()).find(file=>imageTypeForFile(file));if(image){e.preventDefault();sendChatImage(image);return;}const path=pastedImagePath(e.clipboardData?.getData('text/plain'));if(path){e.preventDefault();sendChatImagePath(path);}});
function setHeaderExpanded(expanded){const actions=$('headerActions');const toggle=$('headerToggleBtn');if(!actions||!toggle)return;actions.hidden=!expanded;toggle.setAttribute('aria-expanded',String(expanded));toggle.classList.toggle('is-expanded',expanded);toggle.title=expanded?'Collapse WatchFusion controls':'Expand WatchFusion controls';toggle.querySelector('.sr-only')?.replaceChildren(document.createTextNode(expanded?'Collapse WatchFusion controls':'Expand WatchFusion controls'));document.body.classList.toggle('header-controls-expanded',expanded);try{localStorage.setItem('watchfusion.headerExpanded',expanded?'1':'0');}catch{}}
function expandHeader(expanded){setHeaderExpanded(!!expanded);}
$('headerToggleBtn').onclick=()=>{const actions=$('headerActions');setHeaderExpanded(!!actions?.hidden);};
try{setHeaderExpanded(localStorage.getItem('watchfusion.headerExpanded')==='1');}catch{setHeaderExpanded(false);}
$('nameInput').value=currentName();
$('startPartyBtn').onclick=()=>{lobby.hidden=false;$('roomInput').value='';$('nameInput').focus();expandHeader(true);};
$('openRoomBtn').onclick=()=>{lobby.hidden=false;$('roomInput').focus();expandHeader(true);};
$('closeLobbyBtn').onclick=()=>{lobby.hidden=true;expandHeader(false);};
networkInfoReady=loadNetworkInfo();setInterval(()=>{if(document.visibilityState==='visible')loadNetworkInfo().catch(()=>{});},2500);const initialRoom=roomFromUrl();if(initialRoom)networkInfoReady.then(()=>join(initialRoom,currentName()));window.addEventListener('beforeunload',()=>{savePlayerAudioPrefs();eventSource?.close();if(remotePollTimer)clearInterval(remotePollTimer);if(pingTimer)clearInterval(pingTimer);if(roomId&&session&&!window.watchFusionEveContinuity?.shouldSuppressLeave?.()){const blob=new Blob([JSON.stringify({roomId,memberId:session.memberId})],{type:'application/json'});navigator.sendBeacon?.(apiUrl(`/api/rooms/${roomId}/leave?defer=1&memberId=${encodeURIComponent(session.memberId)}`),blob);}});window.parseYoutubeInput=input=>{const value=String(input||'').trim();const match=value.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/)||value.match(/^([A-Za-z0-9_-]{11})$/);return match?match[1]:value;};
