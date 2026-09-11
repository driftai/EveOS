let resolvedMediaCandidates = [];
function selectedMediaCandidate(){const index=Number($('mediaSourceSelect')?.value);return Number.isInteger(index)?resolvedMediaCandidates[index]:null;}
function onMediaSelectChange(){const candidate=selectedMediaCandidate();if(candidate?.url&&$('sourceInput')){$('sourceInput').value=candidate.url;if(typeof updateSourceInputButton==='function')updateSourceInputButton();}}
function mediaCandidateLabel(item){const server=String(item.server||item.provider||'Unknown server').trim();const audio=String(item.audio||'').toUpperCase();const quality=String(item.quality||'').toUpperCase();const type=String(item.type||'').toUpperCase();return [server,audio,quality,type].filter(Boolean).join(' · ');}
async function resolveMediaInput(){
  if(roomId&&!isHost())return alert('Only the host can resolve media for the room.');
  const input=$('sourceInput')?.value.trim();
  if(!input)return alert('Paste a YouTube URL, direct video/HLS URL, or supported watch-page URL.');
  const button=$('loadBtn');if(button)button.disabled=true;setStatus('Finding playable media...');
  try{
    const res=await fetch(apiUrl('/api/media/resolve'),{method:'POST',headers:{'Content-Type':'application/json',...(session?.memberId?{'x-member-id':session.memberId}:{})},body:JSON.stringify({url:input,...(roomId?{roomId}:{})}),cache:'no-store'});
    const data=await res.json().catch(()=>({}));
    if(!res.ok||!Array.isArray(data.results)||!data.results.length)return setStatus(data.message||data.error||'No playable media was found.');
    resolvedMediaCandidates=data.results;
    const select=$('mediaSourceSelect');if(select)select.innerHTML=resolvedMediaCandidates.map((item,index)=>`<option value="${index}">${escapeHtml(mediaCandidateLabel(item))}</option>`).join('');
    const results=$('mediaSourceResults');if(results)results.hidden=false;
    const first=resolvedMediaCandidates[0];
    if(first?.url&&$('sourceInput')){$('sourceInput').value=first.url;updateSourceInputButton?.();}
    if($('mediaMeta'))$('mediaMeta').textContent=[data.title,`Found ${resolvedMediaCandidates.length} streams`].filter(Boolean).join(' · ');
    setStatus('Media source found');
  }catch(error){setStatus(error?.message||'Media resolver failed.');}finally{if(button)button.disabled=false;}
}
async function loadSelectedMedia(){
  if(roomId&&!isHost())return alert('Only the host can load media for the room.');
  const candidate=selectedMediaCandidate();if(!candidate)return alert('Find a media source first.');
  const originalUrl=$('sourceInput')?.value.trim()||candidate.url;
  if(!roomId){applySoloSource({kind:'media',url:candidate.url,type:candidate.type,server:candidate.server,title:candidate.title||'External media',audio:candidate.audio||null,subtitles:Array.isArray(candidate.subtitles)?candidate.subtitles:[],referer:candidate.referer||originalUrl,originalUrl});sourceInputDirty=false;render();setStatus('Media ready · solo mode');return;}
  const res=await fetch(apiUrl(`/api/rooms/${roomId}/media-source`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify({media:candidate,originalUrl})});
  const data=await res.json().catch(()=>({}));if(!res.ok)return setStatus(data.error||'Could not load media.');state=data.state;sourceInputDirty=false;render();setStatus('Media ready');
}
$('resolveMediaBtn')?.addEventListener('click',resolveMediaInput);
$('loadMediaBtn')?.addEventListener('click',async()=>{if($('findMediaPanel'))$('findMediaPanel').hidden=true;await loadSelectedMedia();});
$('mediaSourceSelect')?.addEventListener('change',onMediaSelectChange);
