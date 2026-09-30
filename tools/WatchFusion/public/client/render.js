let renderedChatSignature='';
function roomImageUrl(attachment){const base=apiUrl(attachment?.url||'');const separator=base.includes('?')?'&':'?';return `${base}${separator}memberId=${encodeURIComponent(session?.memberId||'')}`;}
async function imageBlobAsPng(blob){if(blob.type==='image/png')return blob;const bitmap=await createImageBitmap(blob);const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close?.();return new Promise((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(new Error('Image conversion failed')),'image/png'));}
function legacyCopyRoomImage(button){const msg=button?.closest('.msg');const image=msg?.querySelector('.message-image');if(!image)return false;const fileName=msg?.querySelector('.message-file-name');const selection=getSelection();const saved=[];for(let i=0;i<(selection?.rangeCount||0);i++)saved.push(selection.getRangeAt(i));const oldAlt=image.getAttribute('alt');const oldTitle=image.getAttribute('title');const oldDisplay=fileName?.style.display||'';try{if(fileName)fileName.style.display='none';image.setAttribute('alt','');image.removeAttribute('title');const range=document.createRange();range.selectNode(image);selection?.removeAllRanges();selection?.addRange(range);return document.execCommand('copy');}catch{return false;}finally{if(oldAlt===null)image.removeAttribute('alt');else image.setAttribute('alt',oldAlt);if(oldTitle===null)image.removeAttribute('title');else image.setAttribute('title',oldTitle);if(fileName)fileName.style.display=oldDisplay;selection?.removeAllRanges();saved.forEach(range=>selection?.addRange(range));}}
async function copyRoomImageViaHost(attachment){const base=String(attachment?.url||'');if(!base||!session?.memberId)return false;try{const res=await fetch(apiUrl(`${base}/copy-local`),{method:'POST',headers:{'x-member-id':session.memberId},cache:'no-store'});return res.ok;}catch{return false;}}
function isMobileImageClipboardClient(){try{return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||((navigator.maxTouchPoints||0)>0&&matchMedia('(pointer: coarse)').matches);}catch{return false;}}
function showImageCopyAssist(attachment,imageUrl){let assist=document.querySelector('.image-copy-assist');if(!assist){assist=document.createElement('div');assist.className='image-copy-assist';assist.hidden=true;assist.setAttribute('role','dialog');assist.setAttribute('aria-modal','true');assist.setAttribute('aria-labelledby','imageCopyAssistTitle');assist.innerHTML='<div class="image-copy-assist-card"><strong id="imageCopyAssistTitle">Copy image on phone</strong><p>Press and hold the image, then choose <b>Copy image</b>.</p><img alt="Shared room image"><button type="button" class="secondary">Close</button></div>';assist.querySelector('button').onclick=()=>{assist.hidden=true;};assist.addEventListener('click',event=>{if(event.target===assist)assist.hidden=true;});document.body.appendChild(assist);}const image=assist.querySelector('img');image.src=imageUrl;image.alt=attachment?.name||'Shared room image';assist.hidden=false;return true;}
function setManualCopyFeedback(button){if(!button)return;const previousTimer=Number(button.dataset.copyFeedbackTimer||0);if(previousTimer)clearTimeout(previousTimer);button.textContent='Hold image';button.classList.remove('is-copied','is-copy-failed');button.setAttribute('aria-label','Press and hold the opened image, then choose Copy image');const timer=setTimeout(()=>{button.textContent='Copy';button.setAttribute('aria-label','Copy');delete button.dataset.copyFeedbackTimer;},2400);button.dataset.copyFeedbackTimer=String(timer);}
async function copyRoomImage(attachment,button){const imageUrl=roomImageUrl(attachment);try{if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw new Error('Image clipboard unavailable');const response=await fetch(imageUrl,{cache:'no-store'});if(!response.ok)throw new Error('Image fetch failed');const png=await imageBlobAsPng(await response.blob());await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);return'image';}catch{}if(isMobileImageClipboardClient()&&showImageCopyAssist(attachment,imageUrl))return'assist';if(legacyCopyRoomImage(button))return'image';if(await copyRoomImageViaHost(attachment))return'image';return false;}
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
    const actions=`<span class="msg-actions">${text?`<button type="button" class="message-copy" data-copy-message="${escapeHtml(message.id)}">Copy</button>`:''}${attachment?`<button type="button" class="message-copy message-image-copy" data-copy-image="${escapeHtml(message.id)}">Copy</button>`:''}</span>`;
    const image=attachment?`<a class="message-image-link" href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener"><img class="message-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(attachment.name||'Shared room image')}" loading="lazy"></a><span class="message-file-name">${escapeHtml(attachment.name||'Shared image')}</span>`:'';
    return `<div class="msg" data-message-id="${escapeHtml(message.id)}"><div class="msg-head"><b>${escapeHtml(message.name)}</b>${actions}</div>${text?`<p>${escapeHtml(text)}</p>`:''}${image}</div>`;
  }).join('');
  document.querySelectorAll('[data-copy-message]').forEach(button=>button.addEventListener('click',async()=>{const message=messages.find(item=>item.id===button.dataset.copyMessage);if(!message)return;const copied=await copyText(message.text);setCopyButtonFeedback(button,copied);setStatus(copied?'Message copied':'Could not copy message');}));
  document.querySelectorAll('[data-copy-image]').forEach(button=>button.addEventListener('click',async()=>{const message=messages.find(item=>item.id===button.dataset.copyImage);if(!message?.attachment)return;const copied=await copyRoomImage(message.attachment,button);if(copied==='assist'){setManualCopyFeedback(button);setStatus('Press and hold the image, then choose Copy image');return;}setCopyButtonFeedback(button,copied==='image');setStatus(copied==='image'?'Image copied':'Could not copy image');}));
  if(nearBottom)chat.scrollTop=chat.scrollHeight;else chat.scrollTop=Math.min(previousScrollTop,Math.max(0,chat.scrollHeight-chat.clientHeight));
  renderedChatSignature=signature;
}

function render() {
  if (!state) return;
  const inRoom=!!roomId&&!!session;
  document.documentElement.classList.toggle('watchfusion-room-active',inRoom);
  const source=state.source||{};
  const isLive=source.kind==='live';
  document.documentElement.classList.toggle('watchfusion-audioflix-live',isLive&&source.mode==='audioflix');
  if(!isLive&&!window.watchFusionLinkedTab?.active?.())window.watchFusionLive?.disconnect?.();
  const isNuvio=source.kind==='nuvio';
  const isVoxelVision=source.kind==='voxelvision';
  const isYoutube=source.kind==='youtube'||!!source.videoId;
  const playerHost=$('playerHost');
  const nuvioToolbar=$('nuvioToolbar');
  const nuvioFrame=$('nuvioFrame');
  if(!isNuvio&&nuvioFrame){delete nuvioFrame.dataset.watchFusionNuvioClosed;delete nuvioFrame.dataset.watchFusionNuvioSelected;}
  const nuvioViewVisible=isNuvio&&!isNuvioViewClosed(source);
  const voxelVisionToolbar=$('voxelVisionToolbar');
  const voxelVisionFrame=$('voxelVisionFrame');
  const partyPanel=$('partyPanel');
  const findMediaPanel=$('findMediaPanel');
  $('roomPill').textContent=inRoom?displayRoomLabel():'Solo';
  $('roomPill').title=inRoom?`Copy join code: ${joinCode||roomId}`:'No active room';
  if(partyPanel)partyPanel.hidden=!inRoom;
  if($('roomSplitter'))$('roomSplitter').hidden=!inRoom;
  if($('partyDetails'))$('partyDetails').hidden=!inRoom;
  if($('startPartyBtn'))$('startPartyBtn').hidden=inRoom;
  if($('openRoomBtn'))$('openRoomBtn').hidden=inRoom;
  $('roomPill').disabled=!inRoom;
  if($('hostBadge'))$('hostBadge').textContent=isHost()?(state.temporaryHost?'TEMP HOST':'YOU ARE HOST'):(state.temporaryHost?'TEMP HOST ACTIVE':'');
  if($('leaveRoomBtn'))$('leaveRoomBtn').hidden=!inRoom;
  if($('deleteRoomBtn'))$('deleteRoomBtn').hidden=!isHost();
  if($('syncBtn'))$('syncBtn').hidden=!inRoom||isNuvio||isVoxelVision||isLive;
  if($('copyBtn'))$('copyBtn').hidden=!inRoom;
  updateLanCopyVisibility?.();
  if(playerHost)playerHost.classList.toggle('nuvio-active',nuvioViewVisible);
  if(playerHost)playerHost.classList.toggle('voxelvision-active',isVoxelVision);
  const hasLoadedMedia=isLive||nuvioViewVisible||isVoxelVision||isYoutube||source.kind==='media';
  const hasVisualMedia=(isLive&&source.mode!=='audioflix')||nuvioViewVisible||isVoxelVision||isYoutube||source.kind==='media';
  const idleSolo=!inRoom&&!hasLoadedMedia;
  const watchShell=document.querySelector('.watch-shell');
  if(watchShell)watchShell.classList.toggle('solo-idle',idleSolo);
  if($('soloEmptyState'))$('soloEmptyState').hidden=!idleSolo||findMediaPanel?.hidden===false;
  if($('mediaStage'))$('mediaStage').classList.toggle('media-stage-empty',!hasVisualMedia);
  if($('unloadMediaBtn'))$('unloadMediaBtn').hidden=!hasLoadedMedia||(inRoom&&!isHost());
  if(document.querySelector('.media-status-row')){
    const statusText=String($('syncStatus')?.textContent||'').trim();
    const meaningfulStatus=statusText&&statusText!=='Solo mode';
    document.querySelector('.media-status-row').hidden=idleSolo&&!meaningfulStatus;
  }
  if(nuvioFrame){nuvioFrame.hidden=!nuvioViewVisible;nuvioFrame.style.display=nuvioViewVisible?'block':'none';}
  if(nuvioToolbar)nuvioToolbar.hidden=!nuvioViewVisible;
  if(voxelVisionFrame){voxelVisionFrame.hidden=!isVoxelVision;voxelVisionFrame.style.display=isVoxelVision?'block':'none';}
  if(voxelVisionToolbar)voxelVisionToolbar.hidden=!isVoxelVision;
  const ytFrame=$('player');if(ytFrame){const hideYouTube=isLive||isNuvio||isVoxelVision||!isYoutube;ytFrame.hidden=hideYouTube;ytFrame.style.display=hideYouTube?'none':'block';}
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
  $('sourceModeLabel').textContent=isLive?'Live media':isNuvio?'Nuvio':(isVoxelVision?'VoxelVision':(isYoutube?'YouTube':(source.kind==='media'?'External media':'Ready')));
  const mediaMeta=$('mediaMeta');
  if(mediaMeta){
    if(isNuvio)mediaMeta.textContent=source.title||'Nuvio Integration';
    else if(isVoxelVision)mediaMeta.textContent=source.title||'VoxelVision 3D Media Engine';
    else if(source.kind==='media')mediaMeta.textContent=[source.title,source.server,source.audio?.toUpperCase(),source.type?.toUpperCase()].filter(Boolean).join(' · ')||'Direct media';
    else mediaMeta.textContent='';
  }

  if((source.kind==='live'||source.kind==='media'||source.kind==='nuvio'||source.kind==='voxelvision')&&window.watchPartyProviders){const provider=window.watchPartyProviders.find(source);provider?.load?.(source)?.catch?.(error=>setStatus(error?.message||'Media player failed to initialize.'));}
  else if(source.videoId){window.mediaPlayback?.clear?.();ensurePlayer(source.videoId);}
  if(window.watchFusionLinkedTab?.active?.())window.watchFusionLinkedTab.render?.();
}
