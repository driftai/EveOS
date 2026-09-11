function render() {
  if (!state) return;
  const inRoom=!!roomId&&!!session;
  const source=state.source||{};
  const isNuvio=source.kind==='nuvio';
  const isVoxelVision=source.kind==='voxelvision';
  const isYoutube=source.kind==='youtube'||!!source.videoId;
  const playerHost=$('playerHost');
  const nuvioToolbar=$('nuvioToolbar');
  const nuvioFrame=$('nuvioFrame');
  const voxelVisionToolbar=$('voxelVisionToolbar');
  const voxelVisionFrame=$('voxelVisionFrame');
  const partyPanel=$('partyPanel');
  const findMediaPanel=$('findMediaPanel');
  $('roomPill').textContent=inRoom?displayRoomLabel():'Solo';
  $('roomPill').title=inRoom?`Copy join code: ${joinCode||roomId}`:'No active room';
  if(partyPanel)partyPanel.hidden=!inRoom;
  if($('startPartyBtn'))$('startPartyBtn').hidden=inRoom;
  if($('openRoomBtn'))$('openRoomBtn').hidden=inRoom;
  $('roomPill').disabled=!inRoom;
  if($('hostBadge'))$('hostBadge').textContent=isHost()?(state.temporaryHost?'TEMP HOST':'YOU ARE HOST'):(state.temporaryHost?'TEMP HOST ACTIVE':'');
  if($('deleteRoomBtn'))$('deleteRoomBtn').hidden=!isHost();
  if($('syncBtn'))$('syncBtn').hidden=!inRoom||isNuvio||isVoxelVision;
  if($('copyBtn'))$('copyBtn').hidden=!inRoom;
  if(playerHost)playerHost.classList.toggle('nuvio-active',isNuvio);
  if(playerHost)playerHost.classList.toggle('voxelvision-active',isVoxelVision);
  const hasActiveMedia=isNuvio||isVoxelVision||isYoutube||source.kind==='media';
  if($('mediaStage'))$('mediaStage').classList.toggle('media-stage-empty',!hasActiveMedia);
  if(nuvioFrame){nuvioFrame.hidden=!isNuvio;nuvioFrame.style.display=isNuvio?'block':'none';}
  if(nuvioToolbar)nuvioToolbar.hidden=!isNuvio;
  if(voxelVisionFrame){voxelVisionFrame.hidden=!isVoxelVision;voxelVisionFrame.style.display=isVoxelVision?'block':'none';}
  if(voxelVisionToolbar)voxelVisionToolbar.hidden=!isVoxelVision;
  const ytFrame=$('player');if(ytFrame){const hiddenByTool=isNuvio||isVoxelVision;ytFrame.hidden=hiddenByTool;ytFrame.style.display=hiddenByTool?'none':'block';}
  document.querySelectorAll('.source-tab').forEach(tab=>{
    const active=(isNuvio&&tab.id==='shortcutNuvioBtn')||(isVoxelVision&&tab.id==='shortcutVoxelVisionBtn')||(!isNuvio&&!isVoxelVision&&tab.id==='resolveTabBtn');
    tab.classList.toggle('active',active);
  });

  if($('members'))$('members').innerHTML=state.members.map(m=>{const host=m.id===state.hostId;const owner=m.accountId===state.ownerAccountId;const transfer=isHost()&&!host?`<button class="member-transfer" data-transfer-host="${m.id}" title="Make ${escapeHtml(m.name)} host">Make host</button>`:'';return `<div class="member-row"><span class="member ${host?'host':''}">${escapeHtml(m.name)}${host?' ★':''}${owner&&!host?' 👑':''}</span>${transfer}</div>`;}).join('');
  document.querySelectorAll('[data-transfer-host]').forEach(btn=>btn.addEventListener('click',async()=>{const targetMemberId=btn.getAttribute('data-transfer-host');if(!targetMemberId)return;btn.disabled=true;const ok=await command('transfer-host',{targetMemberId});if(!ok)btn.disabled=false;}));
  if($('chat')){$('chat').innerHTML=state.messages.map(m=>`<div class="msg"><b>${escapeHtml(m.name)}</b><p>${escapeHtml(m.text)}</p></div>`).join('');$('chat').scrollTop=$('chat').scrollHeight;}

  if(!sourceInputDirty&&$('sourceInput')){
    if(source.kind==='media')$('sourceInput').value=source.url||source.originalUrl||'';
    else if(source.kind==='nuvio')$('sourceInput').value=source.originalUrl||source.url||'nuvio://media';
    else if(source.kind==='voxelvision')$('sourceInput').value=source.originalUrl||source.url||'voxelvision://home';
    else $('sourceInput').value=source.originalUrl||(source.videoId?`https://www.youtube.com/watch?v=${source.videoId}`:'');
    updateSourceInputButton?.();
  }
  $('sourceModeLabel').textContent=isNuvio?'Nuvio':(isVoxelVision?'VoxelVision':(isYoutube?'YouTube':(source.kind==='media'?'External media':'Ready')));
  const mediaMeta=$('mediaMeta');
  if(mediaMeta){
    if(isNuvio)mediaMeta.textContent=source.title||'Nuvio Integration';
    else if(isVoxelVision)mediaMeta.textContent=source.title||'VoxelVision 3D Media Engine';
    else if(source.kind==='media')mediaMeta.textContent=[source.title,source.server,source.audio?.toUpperCase(),source.type?.toUpperCase()].filter(Boolean).join(' · ')||'Direct media';
    else mediaMeta.textContent='';
  }

  if((source.kind==='media'||source.kind==='nuvio'||source.kind==='voxelvision')&&window.watchPartyProviders){const provider=window.watchPartyProviders.find(source);provider?.load?.(source)?.catch?.(error=>setStatus(error?.message||'Media player failed to initialize.'));}
  else if(source.videoId){window.mediaPlayback?.clear?.();ensurePlayer(source.videoId);}
}
