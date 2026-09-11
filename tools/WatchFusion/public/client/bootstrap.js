function currentPosition() { return mediaVideo ? (mediaVideo.currentTime || 0) : (ytPlayer?.getCurrentTime?.() || 0); }
async function command(type, extra={}) { const res=await fetch(apiUrl(`/api/rooms/${roomId}/command`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify({type,...extra})});if(!res.ok){const d=await res.json().catch(()=>({}));setStatus(d.error||'Command rejected');return false;}return true; }
function soloPlaybackState(){return{paused:true,ended:false,position:0,rate:1,updatedAt:Date.now()};}
function applySoloSource(source){state={source,playback:soloPlaybackState(),members:[],messages:[],revision:0};sourceInputDirty=false;const hasActive=source&&source.kind!=='ready';if($('mediaStage'))$('mediaStage').classList.toggle('media-stage-empty',!hasActive);if($('partyDetails'))$('partyDetails').hidden=true;if($('partyPanel'))$('partyPanel').hidden=true;if($('syncBtn'))$('syncBtn').hidden=true;if($('copyBtn'))$('copyBtn').hidden=true;if($('deleteRoomBtn'))$('deleteRoomBtn').hidden=true;render();}
async function promoteCurrentSourceToRoom(){const source=state?.source;if(!roomId||!session||!source)return true;if(source.videoId||source.kind==='youtube'||source.type==='youtube'){const ok=await command('source',{input:source.originalUrl||source.videoId});if(!ok)throw new Error('Could not promote YouTube into the room.');return true;}const res=await fetch(apiUrl(`/api/rooms/${roomId}/media-source`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify({media:source,originalUrl:source.originalUrl||source.url})});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'Could not promote the current media into the room.');state=data.state;return true;}
$('createBtn').onclick=async()=>{await networkInfoReady;const name=$('nameInput').value.trim()||'Guest';const requested=$('roomInput').value.trim().toUpperCase();const id=requested||makeRoomId();if(!/^[A-Z0-9_-]{3,32}$/.test(id))return alert('Enter a valid room number or room ID');const sourceBeforeRoom=state?.source?{...state.source}:null;setName(name);try{const res=await fetch(apiUrl(`/api/rooms/${encodeURIComponent(id)}/create`),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,accountId,roomCode:/^[0-9]{1,12}$/.test(id)?id:undefined})});const data=await res.json().catch(()=>({}));if(!res.ok)return alert(data.error||'Could not create room');await join(data.roomId,name,data.roomCode||null);if(sourceBeforeRoom){state.source=sourceBeforeRoom;await promoteCurrentSourceToRoom();render();}if($('lobby'))$('lobby').hidden=true;setHeaderExpanded(false);}catch(error){alert(error?.message||'Could not create room');}};
$('joinBtn').onclick=()=>{const id=$('roomInput').value.trim();const name=$('nameInput').value.trim()||'Guest';if(!/^[A-Za-z0-9_-]{3,32}$/.test(id))return alert('Enter the room number or encoded room ID');join(id,name);};
function updateSourceInputButton(){const btn=$('loadBtn');if(btn)btn.textContent='Find / Load';}
$('sourceInput').addEventListener('input',()=>{sourceInputDirty=true;updateSourceInputButton();});
$('loadBtn').onclick=async()=>{
  if(roomId&&!isHost())return alert('Only the host can load video sources.');
  const input=$('sourceInput').value.trim();
  if(!input)return alert('Paste a YouTube URL, direct video/HLS URL, or supported watch-page URL.');
  if (/^(?:nuvio:\/\/|stremio:\/\/|tt\d{7,10}$)/i.test(input)) return openNuvioBrowserMode();
  if(/\.m3u8(?:$|[?#])/i.test(input)||/\.(mp4|webm|m4v|mkv)(?:$|[?#])/i.test(input)){
    const isHls=/\.m3u8(?:$|[?#])/i.test(input);const source={kind:'media',url:input,type:isHls?'hls':'file',server:new URL(input).hostname,title:'Direct media',originalUrl:input};setStatus('Loading direct media…');
    if($('findMediaPanel'))$('findMediaPanel').hidden=true;
    if(!roomId){applySoloSource(source);setStatus('Media ready · solo mode');return;}
    const res=await fetch(apiUrl(`/api/rooms/${roomId}/media-source`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify({media:source,originalUrl:input})});const data=await res.json().catch(()=>({}));if(!res.ok)return setStatus(data.error||'Could not load media.');state=data.state;sourceInputDirty=false;render();setStatus('Media ready');return;
  }
  const youtubeLike=/^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(input)||/^[A-Za-z0-9_-]{11}$/.test(input);
  if(!youtubeLike&&/^https?:\/\//i.test(input)){await resolveMediaInput();return;}
  if($('findMediaPanel'))$('findMediaPanel').hidden=true;
  if(!roomId){const videoId=window.parseYoutubeInput?window.parseYoutubeInput(input):input;applySoloSource({type:'youtube',kind:'youtube',videoId,originalUrl:input});ensurePlayer(videoId);setStatus('Video ready · solo mode');return;}
  const ok=await command('source',{input});if(ok){sourceInputDirty=false;setStatus('Video ready');}
};
function showFindMedia(){if($('findMediaPanel'))$('findMediaPanel').hidden=false;document.querySelectorAll('.source-tab').forEach(tab=>tab.classList.toggle('active',tab.id==='resolveTabBtn'));if($('sourceModeLabel'))$('sourceModeLabel').textContent='Ready';$('sourceInput')?.focus();}
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
$('closeFindMediaBtn').onclick=()=>{if($('findMediaPanel'))$('findMediaPanel').hidden=true;};
$('syncBtn').onclick=()=>{if(!roomId)return;if(state?.source?.kind==='media')window.mediaPlayback?.sync?.({force:true});else syncPlayer({force:true});};$('copyBtn').onclick=async()=>{const link=shareRoomLink();if(!link)return;setStatus(await copyText(link)?'Room link copied':link);};$('roomPill').onclick=copyJoinCode;$('copyLanBtn').onclick=async()=>{const link=lanRoomLink();if(!link)return setStatus('LAN address not available');setStatus(await copyText(link)?'LAN room link copied (physical LAN IP)':link);};$('deleteRoomBtn').onclick=async()=>{if(!isHost())return;if(!confirm('Delete this room for everyone?'))return;const ok=await command('delete-room');if(ok)leaveRoom('Room deleted.');};$('chatForm').onsubmit=e=>{e.preventDefault();const text=$('chatInput').value.trim();if(!text)return;command('chat',{text});$('chatInput').value='';};
function setHeaderExpanded(expanded){const actions=$('headerActions');const toggle=$('headerToggleBtn');if(!actions||!toggle)return;actions.hidden=!expanded;toggle.setAttribute('aria-expanded',String(expanded));toggle.classList.toggle('is-expanded',expanded);toggle.title=expanded?'Collapse WatchFusion controls':'Expand WatchFusion controls';toggle.querySelector('.sr-only')?.replaceChildren(document.createTextNode(expanded?'Collapse WatchFusion controls':'Expand WatchFusion controls'));document.body.classList.toggle('header-controls-expanded',expanded);try{localStorage.setItem('watchfusion.headerExpanded',expanded?'1':'0');}catch{}}
function expandHeader(expanded){setHeaderExpanded(!!expanded);}
$('headerToggleBtn').onclick=()=>{const actions=$('headerActions');setHeaderExpanded(!!actions?.hidden);};
try{setHeaderExpanded(localStorage.getItem('watchfusion.headerExpanded')==='1');}catch{setHeaderExpanded(false);}
$('nameInput').value=currentName();
$('startPartyBtn').onclick=()=>{lobby.hidden=false;$('roomInput').value='';$('nameInput').focus();expandHeader(true);};
$('openRoomBtn').onclick=()=>{lobby.hidden=false;$('roomInput').focus();expandHeader(true);};
$('closeLobbyBtn').onclick=()=>{lobby.hidden=true;expandHeader(false);};
networkInfoReady=loadNetworkInfo();const initialRoom=roomFromUrl();if(initialRoom)networkInfoReady.then(()=>join(initialRoom,currentName()));window.addEventListener('beforeunload',()=>{savePlayerAudioPrefs();eventSource?.close();if(remotePollTimer)clearInterval(remotePollTimer);if(pingTimer)clearInterval(pingTimer);if(roomId&&session){const blob=new Blob([JSON.stringify({roomId,memberId:session.memberId})],{type:'application/json'});navigator.sendBeacon?.(apiUrl(`/api/rooms/${roomId}/leave?memberId=${encodeURIComponent(session.memberId)}`),blob);}});window.parseYoutubeInput=input=>{const value=String(input||'').trim();const match=value.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/)||value.match(/^([A-Za-z0-9_-]{11})$/);return match?match[1]:value;};
