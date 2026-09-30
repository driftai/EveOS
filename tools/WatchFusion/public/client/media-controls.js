let resolvedMediaCandidates = [];
let resolvedMediaPageUrl = '';
const MEDIA_PREFS_KEY = 'watchfusion.mediaPreferences.v1';

function mediaPreferenceKey(input) {
  try {
    const host = new URL(String(input || '')).hostname.toLowerCase().replace(/^www\./,'');
    return host === 'miruro.ru' || host.endsWith('.miruro.ru') ? 'miruro' : host;
  } catch { return ''; }
}
function mediaPreferences() { try { return JSON.parse(storage.get(MEDIA_PREFS_KEY,'{}')) || {}; } catch { return {}; } }
function mediaPreference(input) { const key=mediaPreferenceKey(input);return key?mediaPreferences()[key]||null:null; }
function saveMediaPreference(input,candidate) {
  const key=mediaPreferenceKey(input);if(!key||!candidate)return;
  const prefs=mediaPreferences();prefs[key]={server:String(candidate.server||candidate.provider||''),audio:String(candidate.audio||''),at:Date.now()};
  storage.set(MEDIA_PREFS_KEY,JSON.stringify(prefs));
}
function mediaCandidateLabel(item) {
  const server=String(item.server||item.provider||'Unknown server').trim();
  const audio=String(item.audio||'').toUpperCase(),quality=String(item.quality||'').toUpperCase(),type=String(item.type||'').toUpperCase();
  return [server,audio,quality,type].filter(Boolean).join(' · ');
}
function preferredCandidateIndex(results,input) {
  if(!Array.isArray(results)||!results.length)return 0;
  const pref=mediaPreference(input),miruro=mediaPreferenceKey(input)==='miruro';let best=0,bestScore=-Infinity;
  results.forEach((item,index)=>{let score=0;const server=String(item.server||item.provider||'').toLowerCase(),audio=String(item.audio||'').toLowerCase();
    if(pref?.server&&server===String(pref.server).toLowerCase())score+=100;
    if(pref?.audio&&audio===String(pref.audio).toLowerCase())score+=45;
    if(!pref&&miruro&&audio==='dub')score+=35;
    if(item.type==='hls')score+=3;
    if(score>bestScore){bestScore=score;best=index;}
  });
  return best;
}
function selectedMediaCandidate(){const index=Number($('mediaSourceSelect')?.value);return Number.isInteger(index)?resolvedMediaCandidates[index]:null;}
function updateMediaCandidateUi(index=0) {
  const select=$('mediaSourceSelect');if(select)select.value=String(Math.max(0,Math.min(resolvedMediaCandidates.length-1,index)));
  if($('mediaSourceInput'))$('mediaSourceInput').value=selectedMediaCandidate()?.url||'';
}
function youtubeId(input){try{return window.parseYoutubeInput?.(input)||null;}catch{return null;}}
function directKind(input){const value=String(input||'');if(/\.m3u8(?:$|[?#])/i.test(value))return'hls';if(/\.(?:mp4|webm|m4v|mkv|ogg|mov)(?:$|[?#])/i.test(value))return'file';return'';}
async function loadYoutubeInput(input) {
  const videoId=youtubeId(input);if(!videoId)return false;
  if(!roomId){applySoloSource({type:'youtube',kind:'youtube',videoId,originalUrl:input});ensurePlayer(videoId);setStatus('Video ready · solo mode');return true;}
  const ok=await command('source',{input});if(ok){sourceInputDirty=false;setStatus('Video ready');}return ok;
}
async function loadMediaCandidate(candidate,originalUrl=resolvedMediaPageUrl) {
  if(!candidate)return false;
  const pageUrl=String(originalUrl||candidate.referer||candidate.url||'');
  if(candidate.type==='youtube'||candidate.provider==='youtube')return loadYoutubeInput(candidate.url||pageUrl);
  const source={kind:'media',url:candidate.url,type:candidate.type,server:candidate.server||candidate.provider||null,
    title:candidate.title||'External media',audio:candidate.audio||null,subtitles:Array.isArray(candidate.subtitles)?candidate.subtitles:[],
    referer:candidate.referer||pageUrl,originalUrl:pageUrl};
  if(!roomId){applySoloSource(source);sourceInputDirty=false;render();setStatus('Media ready · solo mode');}
  else {
    const res=await fetch(apiUrl(`/api/rooms/${roomId}/media-source`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify({media:candidate,originalUrl:pageUrl})});
    const data=await res.json().catch(()=>({}));if(!res.ok){setStatus(data.error||'Could not load media.');return false;}
    state=data.state;sourceInputDirty=false;render();setStatus('Media ready');
  }
  saveMediaPreference(pageUrl,candidate);return true;
}
async function resolveMediaInput(options={}) {
  if(roomId&&!isHost())return false;
  const input=String(options.input??$('sourceInput')?.value??'').trim();
  if(!input){if(!options.silent)alert('Paste a YouTube URL, direct video/HLS URL, or supported watch-page URL.');return false;}
  resolvedMediaPageUrl=input;
  if($('sourceInput')){$('sourceInput').value=input;sourceInputDirty=true;}
  const videoId=youtubeId(input);
  if(videoId&&(/youtube\.com|youtu\.be/i.test(input)||/^[A-Za-z0-9_-]{11}$/.test(input))){
    resolvedMediaCandidates=[{url:input,videoId,type:'youtube',provider:'youtube',server:'youtube.com',title:'YouTube'}];
    updateMediaCandidateUi(0);return options.previewOnly?true:loadYoutubeInput(input);
  }
  const kind=directKind(input);
  if(kind){resolvedMediaCandidates=[{url:input,type:kind,server:new URL(input).hostname,provider:'direct-media',title:'Direct media',referer:input}];updateMediaCandidateUi(0);return options.previewOnly?true:loadMediaCandidate(resolvedMediaCandidates[0],input);}
  const button=$('loadBtn');if(button)button.disabled=true;if(!options.silent)setStatus('Finding playable media...');
  try {
    const res=await fetch(apiUrl('/api/media/resolve'),{method:'POST',headers:{'Content-Type':'application/json',...(session?.memberId?{'x-member-id':session.memberId}:{})},
      body:JSON.stringify({url:input,maxResults:20,...(roomId?{roomId}:{})}),cache:'no-store'});
    const data=await res.json().catch(()=>({}));
    if(!res.ok||!Array.isArray(data.results)||!data.results.length){setStatus(data.message||data.error||'No playable media was found.');return false;}
    resolvedMediaCandidates=data.results;
    const select=$('mediaSourceSelect');if(select)select.innerHTML=resolvedMediaCandidates.map((item,index)=>`<option value="${index}">${escapeHtml(mediaCandidateLabel(item))}</option>`).join('');
    if($('mediaSourceResults'))$('mediaSourceResults').hidden=false;
    const preferred=preferredCandidateIndex(resolvedMediaCandidates,input);updateMediaCandidateUi(preferred);
    if($('mediaMeta'))$('mediaMeta').textContent=[data.title,`Found ${resolvedMediaCandidates.length} streams`].filter(Boolean).join(' · ');
    setStatus(options.autoLoad?'Matching attached source…':'Media source found');
    return options.autoLoad?loadMediaCandidate(resolvedMediaCandidates[preferred],input):true;
  } catch(error){setStatus(error?.message||'Media resolver failed.');return false;}
  finally{if(button)button.disabled=false;}
}
async function resolveAndLoadMediaInput(input,options={}){return resolveMediaInput({input:String(input||'').trim(),autoLoad:true,silent:!!options.silent});}
async function loadSelectedMedia(){const candidate=selectedMediaCandidate();if(!candidate)return alert('Find a media source first.');if(window.watchFusionLinkedTab?.active?.())await window.watchFusionLinkedTab.stop({quiet:true});return loadMediaCandidate(candidate,resolvedMediaPageUrl||$('sourceInput')?.value.trim()||candidate.url);}
$('resolveMediaBtn')?.addEventListener('click',()=>resolveMediaInput());
$('loadMediaBtn')?.addEventListener('click',async()=>{if($('findMediaPanel'))$('findMediaPanel').hidden=true;await loadSelectedMedia();});
$('mediaSourceSelect')?.addEventListener('change',()=>{
  updateMediaCandidateUi(Number($('mediaSourceSelect')?.value)||0);
  saveMediaPreference(resolvedMediaPageUrl,selectedMediaCandidate());
});
window.watchFusionMediaResolver={resolve:resolveMediaInput,resolveAndLoad:resolveAndLoadMediaInput,loadCandidate:loadMediaCandidate,selected:selectedMediaCandidate,preference:mediaPreference,savePreference:saveMediaPreference};
