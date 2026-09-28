let renderedChatSignature='';
function roomImageUrl(attachment){const base=apiUrl(attachment?.url||'');const separator=base.includes('?')?'&':'?';return `${base}${separator}memberId=${encodeURIComponent(session?.memberId||'')}`;}
function renderChatMessages(){
  const chat=$('chat');if(!chat)return;
  const messages=Array.isArray(state?.messages)?state.messages:[];
  const signature=`${roomId||''}:${session?.memberId||''}:`+messages.map(message=>`${message.id}:${message.text?.length||0}:${message.attachment?.id||''}`).join('|');
  if(signature===renderedChatSignature)return;
  const nearBottom=!renderedChatSignature||(chat.scrollHeight-chat.scrollTop-chat.clientHeight)<48;
  const previousScrollTop=chat.scrollTop;
  chat.innerHTML=messages.map(message=>{
    const text=String(message.text||'');
    const attachment=message.attachment;
    const imageUrl=attachment?roomImageUrl(attachment):'';
    const actions=`<span class="msg-actions">${text?`<button type="button" class="message-copy" data-copy-message="${escapeHtml(message.id)}">Copy</button>`:''}${attachment?`<a class="message-download" href="${escapeHtml(imageUrl)}" download="${escapeHtml(attachment.name||'watchfusion-image')}" target="_blank" rel="noopener">Save</a>`:''}</span>`;
    const image=attachment?`<a class="message-image-link" href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener"><img class="message-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(attachment.name||'Shared room image')}" loading="lazy"></a><span class="message-file-name">${escapeHtml(attachment.name||'Shared image')}</span>`:'';
    return `<div class="msg" data-message-id="${escapeHtml(message.id)}"><div class="msg-head"><b>${escapeHtml(message.name)}</b>${actions}</div>${text?`<p>${escapeHtml(text)}</p>`:''}${image}</div>`;
  }).join('');
  document.querySelectorAll('[data-copy-message]').forEach(button=>button.addEventListener('click',async()=>{const message=messages.find(item=>item.id===button.dataset.copyMessage);if(!message)return;const copied=await copyText(message.text);setCopyButtonFeedback(button,copied);setStatus(copied?'Message copied':'Could not copy message');}));
  if(nearBottom)chat.scrollTop=chat.scrollHeight;else chat.scrollTop=Math.min(previousScrollTop,Math.max(0,chat.scrollHeight-chat.clientHeight));
  renderedChatSignature=signature;
}

function render() {
  if (!state) return;
  const inRoom=!!roomId&&!!session;
  document.documentElement.classList.toggle('watchfusion-room-active',inRoom);
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

  if($('members'))$('members').innerHTML=state.members.map(m=>{const host=m.id===state.hostId;const owner=m.isOwner===true;const transfer=isHost()&&!host?`<button class="member-transfer" data-transfer-host="${m.id}" title="Make ${escapeHtml(m.name)} host">Make host</button>`:'';return `<div class="member-row"><span class="member ${host?'host':''}">${escapeHtml(m.name)}${host?' ★':''}${owner&&!host?' 👑':''}</span>${transfer}</div>`;}).join('');
  document.querySelectorAll('[data-transfer-host]').forEach(btn=>btn.addEventListener('click',async()=>{const targetMemberId=btn.getAttribute('data-transfer-host');if(!targetMemberId)return;btn.disabled=true;const ok=await command('transfer-host',{targetMemberId});if(!ok)btn.disabled=false;}));
  renderChatMessages();

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
