(() => {
  // v13.8: confirm source seeks instead of treating a fire-and-forget command as success.
  const CONTROL_ECHO_TTL_MS=2500, SEEK_ACK_TTL_MS=4200, SEEK_RETRY_MS=1400;
  let link=null,peer=null,lastMetadata={},loadedPageUrl='',resolvingUrl='',pendingUrl='',resolveRevision=0,applying=false;
  let lastMirrorAnchor=null,mirrorInFlight=false,queuedMirror=null,seekMirrorDue=null;
  let lastTransportTiming=null, lastSampleAt=0, lastSampleUrl="", transitionPending=false, playbackEchoUntil=0, soloRateEchoUntil=0, audioEchoUntil=0;
  const pendingControls=new Map(); let transportNotice=null;
  const VOLUME_ECHO_TTL_MS = 3000;
  let queuedVolume = null, volumeTimer = null, confirmedVolume = null, zeroVolumeSince = 0, trackTransitions = 0;
  let volumePointerHeld = false, audioIntentAt = 0, volumeRestorePage = '';
  function pinnedVolume(){return roomProof() && isHost() && state?.roomAudioPinned === true && Number.isFinite(state.playback?.volume) ? (state.playback.muted ? 0 : state.playback.volume/100) : null;}
  $('liveVolume')?.addEventListener('pointerdown',()=>{volumePointerHeld=true;});
  for(const kind of ['pointerup','pointercancel','blur'])window.addEventListener(kind,()=>{volumePointerHeld=false;});
  let peerCreatedAt = 0, lastLinkedSampleAt = 0, recoveryWindowAt = 0, soloResolvedKey = ""; const soloSourceKey = () => {const s=state?.source||{},id=s.videoId||window.parseYoutubeInput?.(s.originalUrl||'');return JSON.stringify(id?['youtube',id]:[s.kind,s.url]);};
  let recoveryCount = 0, lastRecoveryAt = -Infinity;
  function peerReady(){return peer?.socket?.readyState === 1 && !!peer.viewerId;} let navigationNotice=null, navigationAgent=null; function backgroundLinkActive(){return !!(roomProof()&&isHost()&&state?.linkedSourceActive===true&&state?.playback?.paused===false&&!state.playback.ended);}
  function recoverLink(reason){
    if(!link || !canControl() || (document.hidden&&(!backgroundLinkActive()||!['socket-not-ready','stale-metadata'].includes(reason))))return false;
    const now=performance.now();
    if(now-peerCreatedAt<1500 || now-lastRecoveryAt<5000)return false;
    if(now-recoveryWindowAt>30000){recoveryWindowAt=now;recoveryCount=0;}
    if(recoveryCount>=2){status('Source connection unavailable · check the paired tab or use Reconnect.');return false;}
    recoveryCount++;lastRecoveryAt=now;
    window.watchFusionRoomSyncLog?.note?.('linked-auto-reconnect',{reason,attempt:recoveryCount});
    connectPeer();status('Restoring linked source · awaiting connection…');return true;
  }
  function deliver(action,value,pending){
    if(!peerReady()){
      if(pending)pending.queued=true;
      recoverLink('control-disconnected');return false;
    }
    let sent=false;
    try{sent=peer.control(action,value)===true;}catch{}
    if(pending){pending.queued=!sent;if(sent){pending.lastSent=performance.now();pending.lastSentWall=Date.now();}}
    if(!sent)recoverLink('control-send-failed');
    return sent;
  }
  function replayQueued(){
    if(document.hidden||!peerReady())return;
    for(const action of ['seek','play','pause','rate','volume']){
      const p=pendingControls.get(action);
      if(!p?.queued)continue;
      const ttl=action==='seek'?SEEK_ACK_TTL_MS:action==='volume'?VOLUME_ECHO_TTL_MS:CONTROL_ECHO_TTL_MS;
      if(performance.now()-p.at>ttl){pendingControls.delete(action);status('Queued source command expired · try again.');continue;}
      if(deliver(action,p.value,p)){if(action==='seek')stampSeekDelivery(p);window.watchFusionRoomSyncLog?.note?.('linked-queued-control-sent',{action});}
    }
  }
  function connectionWatchdog(){
    if(!link || (document.hidden&&!backgroundLinkActive()))return;window.WatchFusionLinkedAcquisition?.connection?.(peerReady(),lastLinkedSampleAt?Date.now()-lastLinkedSampleAt:performance.now()-peerCreatedAt,!!lastLinkedSampleAt);
    if(!peerReady()){
      if(performance.now()-peerCreatedAt>4000)recoverLink('socket-not-ready');
    }else{
      replayQueued();
      if((lastLinkedSampleAt?Date.now()-lastLinkedSampleAt:performance.now()-peerCreatedAt)>6500 && (state?.playback?.paused===false || (!document.hidden&&pendingControls.size)))recoverLink('stale-metadata');
    }
    if(navigationNotice&&performance.now()>(navigationNotice.deadline??navigationNotice.at+5000)){const n=navigationNotice;status('Linked '+n.action+' unconfirmed · check the source playlist.');if(navigationAgent)navigationAgent.cancel(n.observed?'navigation-transition-unattributed':'navigation-unconfirmed');else{window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'navigation-unconfirmed',action:n.action});navigationNotice=null;}} for(const [action,p] of pendingControls){
      const ttl=action==='seek'?SEEK_ACK_TTL_MS:action==='volume'?VOLUME_ECHO_TTL_MS:CONTROL_ECHO_TTL_MS;
      if(performance.now()-p.at>ttl){
        pendingControls.delete(action);
        status('Linked '+action+(p.queued?' not delivered':' unconfirmed')+' · source unavailable.');
        window.watchFusionRoomSyncLog?.note?.('source-control-timeout',{action,queued:!!p.queued});
      }
    }
  }
  function active(){return !!link;}
  function roomProof(){return roomId && link?.roomId === roomId ? {id:link.id,token:link.publisherToken} : undefined;}
  async function bindRoom(source, targetRoom) {
    const bound=await post(`/api/live/${source.id}/room`,{publisherToken:source.publisherToken,roomId:targetRoom,mode:'linked-tab'});
    if(roomId!==targetRoom)throw new Error('Room changed while attaching source.');
    source.roomId=targetRoom;
    if(bound.state&&applyIncomingRoomState(bound.state))render();
  }
  async function promoteToRoom() {
    if(!link||!roomId)return false;
    await bindRoom(link,roomId);
    lastMirrorAnchor=null;
    scheduleMirror(lastMetadata,true);
    return true;
  }
  function canControl(){return link?.roomId ? isHost() && !!roomProof() : !roomId;}
  function setApplying(value,kind){if(kind==='solo-audio'){if(value)audioEchoUntil=performance.now()+250;return;}applying=!!value;}
  function suppressPlaybackEcho(owner){if(!active())return;if(owner==='solo-rate'&&!roomId)soloRateEchoUntil=performance.now()+650;else playbackEchoUntil=performance.now()+650;}  function soloCorrectionBlock(){return transitionPending?'transition-pending':applying?'source-apply':performance.now()<playbackEchoUntil?'external-echo':window.WatchFusionHostPeerRecovery?.suppressEcho?.()===true?'host-recovery':null;}
  function status(message){if($('liveStatus'))$('liveStatus').textContent=message;}
  function clock(value){const n=Math.max(0,Math.floor(Number(value)||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
  async function post(path,body={}){
    const res=await fetch(apiUrl(path),{method:'POST',headers:{'Content-Type':'application/json',...(session?.memberId?{'x-member-id':session.memberId}:{})},body:JSON.stringify(body)});
    const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||data.message||'Linked-tab request failed.');return data;
  }
  function renderControls(metadata=applyPendingControls(lastMetadata,{})){
    if(!active())return;
    document.querySelector('.watch-shell')?.classList.add('linked-tab-active');
    const controls=$('liveControls');if(controls)controls.hidden=false;
    $('liveVideo').hidden=true;$('liveListen').hidden=true;$('liveStats').hidden=true;$('liveAudioSyncWrap').hidden=true;$('liveQueueTools').hidden=true;$('liveQueueWrap').hidden=true;
    $('liveTitle').textContent=metadata.title||'Attached tab';$('liveGroup').textContent='State link';
    $('liveToggle').textContent=metadata.paused!==false?'Play':'Pause';$('liveTime').textContent=`${clock(metadata.currentTime)} / ${clock(metadata.duration)}`;
    if(document.activeElement!==$('liveSeek')){$('liveSeek').max=metadata.duration||0;$('liveSeek').value=metadata.currentTime||0;}
    if(document.activeElement!==$('liveRate'))$('liveRate').value=String(metadata.rate||1);
    const volume = $('liveVolume');
    if (!volumePointerHeld) volume.value = queuedVolume ?? pendingControls.get('volume')?.value ?? pinnedVolume() ?? metadata.volume ?? confirmedVolume ?? ((state?.playback?.volume ?? playerAudioPrefs.volume ?? 100) / 100);
    for(const button of controls.querySelectorAll('[data-live-action]'))button.disabled=!canControl();
    for(const id of ['liveSeek','liveRate','liveVolume'])$(id).disabled=!canControl();
    $('liveStop').hidden=false;$('linkTabBtn').textContent='Unlink playing tab';$('linkTabBtn').setAttribute('aria-pressed','true');
  }
  function restoreUi(){
    window.WatchFusionPlaylistContinuity?.reset?.();
    document.querySelector('.watch-shell')?.classList.remove('linked-tab-active');
    $('linkTabBtn').textContent='Link a playing tab';$('linkTabBtn').setAttribute('aria-pressed','false');
    if(state?.source?.kind!=='live')$('liveControls').hidden=true;
    $('liveListen').hidden=false;$('liveStats').hidden=false;
  }
  function noticeLabel(n){return ['Waiting for linked source '+n.action+' confirmation…','Source link recovering · '+n.action+' queued, not yet delivered.','Linked '+n.action+' not delivered · source unavailable.','Linked '+n.action+' unconfirmed · source unavailable.','Source '+n.action+' unconfirmed · use Reconnect.'].includes($('liveStatus')?.textContent);}
  function confirmTransportNotice(sample,now){const n=transportNotice,age=now-Number(sample.sampledAt);if(!n||n.link!==link||!n.page||sample.pageUrl!==n.page||!Number.isFinite(age)||age<0||age>1500||Number(sample.sampledAt)<n.at)return;
    if(n.action==='play'?(sample.paused!==false||sample.ended===true||sample.buffering===true):sample.paused!==true)return;if(age>900)return;if(noticeLabel(n))status(n.action==='play'?'Linked source playing · confirmed':'Linked source paused · confirmed');transportNotice=null;window.WatchFusionLinkedAcquisition?.confirmedTransport?.(sample,n.action);return n.action;}
  function stampSeekDelivery(pending){if(pending&&!pending.firstSentAt){pending.firstSentAt=Date.now();pending.page=lastMetadata.pageUrl;pending.origin={position:lastMetadata.currentTime,stamp:lastMetadata.sampledAt,paused:lastMetadata.paused,rate:lastMetadata.rate};}}
  function control(action,value,explicitRoomVolume=false){
    if(!peer||!canControl()){status('Linked source unavailable · use Reconnect to restore controls.');return false;}
    if (action === 'toggle') {
      const transport = applyPendingControls(lastMetadata,{});
      action = transport.paused !== false ? 'play' : 'pause';
      value = window.WatchFusionLinkedPlaybackSync.projectedPosition(transport);
    }
    if(action==='pause')window.WatchFusionPlaylistContinuity?.manualPause?.(undefined,true);
    const numeric = ['prev','next'].includes(action) ? 0 : Number(value);
    if (!Number.isFinite(numeric)) return false;
    if (action === 'volume' && explicitRoomVolume && roomProof()) {
      volumeRestorePage=lastMetadata.pageUrl||'';audioIntentAt=Math.max(Date.now(),audioIntentAt+1);
      void command('volume',{linkedSource:roomProof(),volume:Math.round(numeric*100),muted:numeric===0,audioIntentAt}).then(ok=>{if(!ok)status('Room volume not confirmed · try again.');else renderControls();}).catch(()=>status('Room volume not confirmed · try again.'));
    } else if (action === 'volume' && pinnedVolume() !== null) return true;
    if (action === 'volume' && (pendingControls.get('volume')?.value ?? lastMetadata.volume) === numeric) return true;
    if (action === 'play' || action === 'pause') {const opposite=action==='play'?'pause':'play';if(pendingControls.delete(opposite))window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'source-command-superseded',action:opposite});transportNotice={action,link,page:lastMetadata.pageUrl,at:Date.now()};}
    if (['seek','play','pause','rate','volume'].includes(action)) {
      const at = performance.now();
      if(pendingControls.has(action)&&['seek','play','pause'].includes(action))window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'source-command-superseded',action});pendingControls.set(action,{value:numeric,at,sampledAt:Date.now(),lastSent:at,retries:0});
    }
    window.watchFusionRoomSyncLog?.note?.('embedded-control',action==='volume' ? {action,volumePct:Math.round(numeric*100)} :
      action==='rate' ? {action,rate:Math.round(numeric*100)/100} : {action,positionMs:Math.round(numeric*1000)});
    if(['next','prev'].includes(action)){navigationAgent??=window.WatchFusionLinkedNavigation?.create?.({getNotice:()=>navigationNotice,setNotice:n=>navigationNotice=n,owner:()=>link,page:()=>lastMetadata.pageUrl,deliver,log:(reason,d)=>window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason,...d}),status,ready:()=>canControl()&&peerReady(),videoId:u=>window.parseYoutubeInput?.(u)});return navigationAgent?.begin(action)??false;} const delivered=deliver(action,numeric,pendingControls.get(action));if(delivered&&action==='seek')stampSeekDelivery(pendingControls.get(action));
    if(!delivered)status('Source link recovering · '+action+' queued, not yet delivered.');
    if (action === 'seek') { status('Seeking linked source · awaiting confirmation…'); renderControls(); }
    if (action === 'play' || action === 'pause') { if(delivered)status('Waiting for linked source ' + action + ' confirmation…'); renderControls(); }
    if (action === 'volume') renderControls();
    return delivered;
  }
  function queueVolume(value, commit = false) {
    if (!peer || !canControl() || !Number.isFinite(value)) return;
    queuedVolume = value;
    const flush = () => {
      clearTimeout(volumeTimer);
      volumeTimer = null;
      const requested = queuedVolume;
      queuedVolume = null;
      if (requested !== null) control('volume',requested,true);
    };
    if (commit) flush();
    else if (volumeTimer === null) volumeTimer = setTimeout(flush,120);
  }
  function clearVolumeDraft() {
    clearTimeout(volumeTimer);
    volumeTimer = null;
    queuedVolume = null;
  }
  // Source volume gets at most two acknowledgement retries.
  function retryVolumeControl() {
    if (!active() || !peer || !canControl() || document.hidden) return;
    const pending=pendingControls.get('volume');
    if (!pending) return;
    const age=performance.now()-pending.at;
    if (age > VOLUME_ECHO_TTL_MS) {
      pendingControls.delete('volume');
      renderControls();
      window.watchFusionRoomSyncLog?.note?.('source-volume-unconfirmed',{volumePct:Math.round(pending.value*100)});
      return;
    }
    if (pending.queued || pending.retries >= 2 || performance.now()-pending.lastSent < 650) return;
    if(deliver('volume',pending.value,pending))pending.retries++;
  }
  function retrySeekControl() {
    if (!active() || !peer || !canControl() || document.hidden) return;
    const pending = pendingControls.get('seek');
    if (!pending) return;
    const age = performance.now() - pending.at;
    if (age > SEEK_ACK_TTL_MS) {
      pendingControls.delete('seek');
      status('Source seek unconfirmed · use Reconnect if the playbar is still behind.');
      window.watchFusionRoomSyncLog?.note?.('source-seek-unconfirmed', {positionMs:Math.round(pending.value*1000)});
      scheduleMirror(lastMetadata, true);
      return;
    }
    if (pending.queued || pending.retries >= 1 || age < SEEK_RETRY_MS || pending.landingSeen || seekLanding(pending,lastMetadata,true)) return;
    if(!deliver('seek',pending.value,pending))return;
    pending.retries++;
    window.watchFusionRoomSyncLog?.note?.('source-seek-retry',{positionMs:Math.round(pending.value*1000)});
  }
  function retryTransportControl() {
    if (!active() || !peer || !canControl() || document.hidden) return;
    for (const action of ['play','pause']) {
      const p = pendingControls.get(action);
      if (!p || p.queued || p.retries >= 1 || performance.now() - (p.lastSent??p.at) < 1000) continue;const age=Date.now()-Number(lastMetadata.sampledAt);if(!Number.isFinite(age)||age<0||age>900||Number(lastMetadata.sampledAt)<(p.lastSentWall??p.sampledAt)||lastMetadata.buffering||pendingSatisfied(action,p,lastMetadata))continue;
      if(!deliver(action,p.value,p))continue;
      p.retries++;
      window.watchFusionRoomSyncLog?.note?.('source-transport-retry',{action});
    }
  }
  setInterval(() => { connectionWatchdog(); retryVolumeControl(); retrySeekControl(); retryTransportControl(); }, 260);
  function pendingSatisfied(action,pending,metadata){if(action==='seek')return seekLanding(pending,metadata);
    if(action==='play')return metadata.paused===false;
    if(action==='pause')return metadata.paused===true;
    if(action==='rate')return Math.abs((Number(metadata.rate)||1)-pending.value)<=0.02;
    if(action==='volume')return Number.isFinite(metadata.volume) && Math.abs(metadata.volume-pending.value)<=0.03;
    return true;
  }
  function seekLanding(pending,metadata,allowBuffering=false){
    const stamp=Number(metadata.sampledAt),age=Date.now()-stamp,elapsed=(stamp-Number(pending.firstSentAt))/1000; if(!pending.firstSentAt||pending.queued||!pending.page||metadata.pageUrl!==pending.page||!Number.isFinite(age)||age<0||age>900||!Number.isFinite(elapsed)||elapsed<0||performance.now()-pending.at>SEEK_ACK_TTL_MS||metadata.ended||typeof metadata.paused!=='boolean'||(!allowBuffering&&metadata.buffering))return false;
    const rate=metadata.paused===true||metadata.buffering?0:Math.min(2,Math.max(.25,Number(metadata.rate)||1)),observed=Number(metadata.currentTime); if(metadata.currentTime==null||!Number.isFinite(observed)||observed<pending.value-.65||observed>pending.value+elapsed*rate+.65)return false;
    const o=pending.origin;if(!o||!Number.isFinite(o.position)||!Number.isFinite(o.stamp)||o.stamp>pending.firstSentAt||pending.firstSentAt-o.stamp>900)return Math.abs(observed-pending.value)<=.65;const baseRate=o.paused?0:Math.min(2,Math.max(.25,Number(o.rate)||1)),natural=o.position+(stamp-o.stamp)/1000*baseRate,atSend=o.position+(pending.firstSentAt-o.stamp)/1000*baseRate;return Math.abs(observed-natural)>.65||Math.abs(atSend-pending.value)<=.65;
  }
  function applyPendingControls(metadata, sample){
    const next={...metadata},now=performance.now();
    for(const [action,pending] of pendingControls){
      const sampledAfterCommand = Number(sample.sampledAt) >= pending.sampledAt; if(action==='seek'&&sampledAfterCommand&&seekLanding(pending,sample,true))pending.landingSeen=true;
      const expired = now - pending.at > (action === 'volume' ? VOLUME_ECHO_TTL_MS : action === 'seek' ? SEEK_ACK_TTL_MS : CONTROL_ECHO_TTL_MS);
      if ((expired && action !== 'volume') || (sampledAfterCommand && pendingSatisfied(action,pending,sample))) {
        if (expired && action === 'seek' && !(sampledAfterCommand&&pendingSatisfied(action,pending,sample))) {
          status('Source seek unconfirmed · use Reconnect if playback is still behind.');
          window.watchFusionRoomSyncLog?.note?.('source-seek-unconfirmed',{positionMs:Math.round(pending.value*1000)});
        }
        if (expired && (action === 'play' || action === 'pause')) {
          status('Source ' + action + ' unconfirmed · use Reconnect.');
          window.watchFusionRoomSyncLog?.note?.('source-transport-unconfirmed',{action});
        }
        pendingControls.delete(action);
        continue;
      }
      if(action==='seek'||action==='play'||action==='pause'){
        next.currentTime=pending.value;next.sampledAt=pending.sampledAt;
        if(action==='play')next.paused=false;
        if(action==='pause')next.paused=true;
      }else if(action==='rate')next.rate=pending.value;
      else if(action==='volume'&&!expired)next.volume=pending.value;
    }
    return next;
  }
  function followLocal(metadata,force=false,sourceSample=metadata){
    if(transitionPending||!state?.source || (roomProof() && !isHost()))return;
    // The linked-room viewer arbiter owns host transport.
    if(roomId && state.linkedSourceActive === true && state.source.videoId && followsRoomPlayback())return;
    if(state.source.videoId||state.source.kind==='youtube'){
      window.watchFusionYoutubeFollow?.(metadata,{force,sourceSample});return;
    }
    applying=true;
    try{if(state.source.kind==='media')window.mediaPlayback?.followAttached?.(metadata,{force});}
    finally{setTimeout(()=>{applying=false;},320);}
  }
  const mirrorGuard=()=>window.WatchFusionLinkedMirrorGuard;
  function mirrorAuthority(){return{roomId,linkId:link?.id,hostId:state?.hostId,host:isHost(),linkedActive:state?.linkedSourceActive===true,proof:!!roomProof(),
    sourceKey:state?.source?.videoId||state?.source?.url||'',sourceMatches:!!(state?.source?.videoId&&window.parseYoutubeInput?.(loadedPageUrl)===state.source.videoId),
    say:why=>status(why==='ownership-denied'?'Linked source: room ownership changed · press Reconnect, or unlink and relink.':why==='not-current-host'?'Linked source paused while another member hosts.':'Linked source is detached from the room.')};}
  async function rebindAfterHandoff(){const target=link;try{await bindRoom(target,roomId);lastMirrorAnchor=null;status('Linked source restored after host return.');scheduleMirror(lastMetadata,true);}
    catch{mirrorGuard()?.result(false,403,()=>status('Linked source could not be restored · press Reconnect, or unlink and relink.'));}}
  async function mirrorNow(metadata,force=false){
    if(!active()||!loadedPageUrl||metadata.pageUrl&&metadata.pageUrl!==loadedPageUrl)return;
    const gate=roomId?mirrorGuard()?.gate?.(mirrorAuthority()):null;
    if(gate?.rebind){void rebindAfterHandoff();return false;}
    if(gate&&!gate.allow)return false;
    if (pendingControls.has('seek') || pendingControls.has('play') || pendingControls.has('pause')) return false;
    const pinned=window.watchFusionLinkedTab?.pinnedVolume?.();if(Number.isFinite(pinned))metadata={...metadata,volume:pinned,muted:pinned===0};
    const sourceVolume = metadata.muted === true ? 0 : metadata.volume;
    const audio = Number.isFinite(sourceVolume) ? {volume:Math.round(sourceVolume * 100),muted:sourceVolume === 0} : {};
    if (roomId && mirrorInFlight) {
      queuedMirror={metadata:{...metadata},force:queuedMirror?.force===true||force};
      return false;
    }
    const age=Date.now()-Number(metadata.sampledAt); if(!roomId&&!force&&lastMirrorAnchor&&metadata.paused===false&&!metadata.ended&&!lastMirrorAnchor.paused&&!lastMirrorAnchor.ended&&Math.abs((Number(metadata.rate)||1)-lastMirrorAnchor.rate)<.01&&(!Number.isFinite(metadata.volume)||(Number.isFinite(lastMirrorAnchor.volume)&&Math.abs(metadata.volume-lastMirrorAnchor.volume)<=.02))&&age>900){window.watchFusionRoomSyncLog?.note?.('mirror-stale-skipped',{sampleAgeMs:age});return false;} const plan=window.WatchFusionLinkedPlaybackSync?.mirrorPlan?.(metadata,lastMirrorAnchor,{force});
    if (!plan?.publish) {
      if (roomId) window.WatchFusionMirrorConvergenceGate?.observeSteady?.(plan,metadata,loadedPageUrl);
      return false;
    }
    if (roomId && !force && window.WatchFusionMirrorConvergenceGate?.rebase?.(plan,metadata,loadedPageUrl)) { lastMirrorAnchor = plan.anchor; return false; }
    if(roomId&&!force&&mirrorGuard()?.stalledRepeat?.(plan,metadata,loadedPageUrl))return false;
    if(roomId&&!force&&window.WatchFusionMirrorConvergenceGate?.defer?.(plan,metadata,loadedPageUrl))return false;
    window.watchFusionRoomSyncLog?.note?.('mirror-request',{
      reason:plan.reason,paused:!!metadata.paused,positionMs:Math.round(plan.target*1000)});
    if(!roomId){
      if(state?.playback)state.playback={...state.playback,position:plan.target,paused:!!metadata.paused,ended:!!metadata.ended,
        rate:Number(metadata.rate)||1,...audio,updatedAt:Date.now()};
      lastMirrorAnchor=plan.anchor;return true;
    }
    const linkedSource=roomProof();
    if(!linkedSource)return;
    const activeLink=link, activePage=loadedPageUrl, receipt={};
    mirrorInFlight=true;const mirrorStartedAt=performance.now();
    try{
      const sourceKey = state?.source?.videoId || state?.source?.url || '';
      const ok=await command('mirror',{linkedSource,sourceKey,position:plan.target,paused:!!metadata.paused,ended:!!metadata.ended,
        rate:Number(metadata.rate)||1,...audio,...(plan.volumeOnly===true?{volumeOnly:true}:{})},receipt);
      if(link!==activeLink||loadedPageUrl!==activePage||!receipt.status)return false;
      mirrorGuard()?.result?.(ok,receipt.status,mirrorAuthority().say);
      const timing={reason:plan.reason,roundTripMs:Math.round(performance.now()-mirrorStartedAt),sampleAgeMs:receipt.sampleAgeMs};
      if(ok){lastMirrorAnchor=plan.anchor;window.watchFusionRoomSyncLog?.note?.('mirror-applied',timing);}
      else if(receipt.status===408){if(force)lastMirrorAnchor=null;window.watchFusionRoomSyncLog?.note?.('mirror-expired',timing);}
      return ok;
    }catch{
      mirrorGuard()?.result?.(false,0);
      status('Linked source reconnecting…');
      return false;
    }finally{
      mirrorInFlight=false;
      const queued=queuedMirror;queuedMirror=null;
      if(queued&&link===activeLink&&queued.metadata.pageUrl===loadedPageUrl)void mirrorNow(queued.metadata,queued.force);
    }
  }
  function scheduleMirror(metadata,force=false){
    if(transitionPending||!loadedPageUrl||metadata.pageUrl!==loadedPageUrl)return;lastMetadata=metadata;const helper=window.WatchFusionLinkedTransition,anchor=lastMirrorAnchor,owner=link,page=loadedPageUrl;
    if(!roomId&&!force&&anchor&&metadata.paused===false&&!metadata.ended&&!metadata.buffering&&!anchor.paused&&!anchor.ended&&Math.abs((Number(metadata.rate)||1)-anchor.rate)<.01&&(!Number.isFinite(metadata.volume)||(Number.isFinite(anchor.volume)&&Math.abs(metadata.volume-anchor.volume)<=.02))&&helper?.queueMirror){if(helper.queueMirror(()=>{if(link===owner&&!roomId&&!transitionPending&&page===loadedPageUrl&&metadata===lastMetadata)void mirrorNow(metadata,false);}))window.watchFusionRoomSyncLog?.note?.('mirror-stale-skipped',{reason:'arrival-coalesced'});return;}helper?.cancelMirror?.();void mirrorNow(metadata,force);
  }
  async function followUrl(url){
    const value=String(url||'').trim();if(!/^https?:\/\//i.test(value)||value===loadedPageUrl||value===resolvingUrl)return;
    if(loadedPageUrl&&state?.source?.videoId&&window.parseYoutubeInput?.(value)===state.source.videoId){
      loadedPageUrl=value;
      followLocal(lastMetadata);
      scheduleMirror(lastMetadata);
      return;
    }
    if(resolvingUrl){pendingUrl=value;return;}
    const revision=++resolveRevision;resolvingUrl=value;pendingUrl='';status('Attached tab changed · resolving its playable source…');
    if (roomId && !roomProof()) { resolvingUrl='';return; }
    const resolve=window.watchFusionMediaResolver?.resolveAndLoad;
    const ok=resolve&&await resolve(value,{silent:true,linkedSource:roomProof()}).catch(()=>false);
    if(revision!==resolveRevision)return;
    resolvingUrl='';
    if(ok){
      loadedPageUrl=value;lastMirrorAnchor=null;queuedMirror=null;soloResolvedKey=soloSourceKey();
      if (lastMetadata.pageUrl !== value && !roomProof()) clearVolumeDraft();
      for (const action of pendingControls.keys()) if (action !== 'volume') pendingControls.delete(action);
      if (lastMetadata.pageUrl === value) {
        renderControls(lastMetadata);followLocal(lastMetadata,true);scheduleMirror(lastMetadata,true);
      }
      status('Attached tab state linked · awaiting local playback confirmation.');
    }
    else status('Attached tab is connected, but its playable source could not be resolved yet.');
    const queued=pendingUrl;pendingUrl='';
    if(queued&&queued!==loadedPageUrl)void followUrl(queued);
  }
  function reconcileSourceVolume(sample, previous, now) {
    const incoming = sample.volume;
    if (incoming == null || !Number.isFinite(incoming) || incoming < 0 || incoming > 1) return confirmedVolume ?? previous.volume;
    if (incoming > 0 || pendingControls.get('volume')?.value === 0) {
      zeroVolumeSince = 0; confirmedVolume = incoming; return incoming;
    }
    if (sample.muted === true && confirmedVolume > 0) return confirmedVolume;
    if (confirmedVolume > 0 && (!zeroVolumeSince || now - zeroVolumeSince < 750)) {
      if (!zeroVolumeSince) zeroVolumeSince = now;
      return confirmedVolume; // one stale/ambiguous zero must not collapse the slider
    }
    confirmedVolume = 0; zeroVolumeSince = 0; return 0;
  }
  function onMetadata(metadata={}){
    const now = Date.now(), sync = window.WatchFusionLinkedPlaybackSync;
    lastTransportTiming=sync?.transportTiming?.(metadata,now)||null;
    if(roomId&&link?.roomId!==roomId)return;
    const sample = sync?.relaySample(metadata, now, window.watchPartyClock?.serverAt?.(now), window.watchPartyClock?.witnessReady?.() ? 45 : null);
    if (!sample || metadata.status?.startsWith('Waiting for playable media')||window.WatchFusionSourceDelivery?.admit?.(metadata,now,link?.id,sample)===false) return;
    if (Number(metadata.sampledAt) <= lastSampleAt) return;
    lastSampleAt = Number(metadata.sampledAt);
    const deliveryGap=lastLinkedSampleAt?now-lastLinkedSampleAt:0;if(lastLinkedSampleAt&&now-lastLinkedSampleAt>1800)window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'source-sample-gap',sampleAgeMs:Math.round(now-lastLinkedSampleAt)});window.WatchFusionSourceDelivery?.observe?.(metadata,now,link?.id,(reason,d)=>window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason,...d}));lastSampleUrl = metadata.pageUrl;lastLinkedSampleAt=now;
    if(typeof navigationAgent!=='undefined')navigationAgent?.observe(sample,false);const previous=lastMetadata; const wasPending=transitionPending;transitionPending=window.WatchFusionLinkedTransition?.accept?.(previous,sample,Number(metadata.sampledAt),now)===false;if(transitionPending){if(!wasPending)window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'source-transition-pending'});window.WatchFusionLinkedTransition?.cancelMirror?.();return;}if(wasPending)window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'source-transition-coherent'});
    window.WatchFusionPlaylistContinuity?.onTransition?.(previous,sample,{eligible:!!(roomProof()&&isHost())});
    if (previous.pageUrl && previous.pageUrl !== sample.pageUrl) {
      if(transportNotice&&noticeLabel(transportNotice))status('Linked source changed · matching media…');transportNotice=null;trackTransitions++;for(const action of pendingControls.keys())if(['seek','play','pause'].includes(action))window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'source-command-track-changed',action});
      volumeRestorePage=''; for(const action of pendingControls.keys())if(action!=='volume')pendingControls.delete(action);seekMirrorDue=null;window.WatchFusionLinkedAcquisition?.reset?.(); if(!roomProof()){clearVolumeDraft();pendingControls.delete('volume');}
      confirmedVolume = null; zeroVolumeSince = 0;
    }
    lastMetadata = { ...lastMetadata, ...sample, sourcePlayerSilenced:typeof sample.sourcePlayerSilenced==='boolean'?sample.sourcePlayerSilenced:null, volume:reconcileSourceVolume(sample, previous, now) };if(previous.pageUrl&&previous.pageUrl!==sample.pageUrl)window.watchFusionRoomSyncLog?.note?.('source-track-transition',{sequence:trackTransitions,sourceAgeMs:Math.round(now-Number(sample.sampledAt))});
    if(typeof navigationAgent!=='undefined')navigationAgent?.observe(sample,true);if(previous.pageUrl===sample.pageUrl && previous.paused!==undefined && previous.paused!==sample.paused)
      window.watchFusionRoomSyncLog?.note?.(sample.paused?'source-pause':'source-play',
        {positionMs:Math.round((Number(sample.currentTime)||0)*1000),sampleAgeMs:Math.round(now-Number(sample.sampledAt))});
    if(previous.pageUrl===sample.pageUrl && Number.isFinite(previous.volume) && Number.isFinite(sample.volume) &&
        Math.abs(previous.volume-sample.volume)>.03)
      window.watchFusionRoomSyncLog?.note?.('source-volume',{volumePct:Math.round(sample.volume*100)});
    const target=pendingControls.get('volume')?.value ?? pinnedVolume();
    if(Number.isFinite(target)&&queuedVolume===null&&Number.isFinite(sample.volume)&&Math.abs(sample.volume-target)>.03&&volumeRestorePage!==sample.pageUrl&&roomProof()&&canControl()){
      volumeRestorePage=sample.pageUrl;const at=performance.now();const pending={value:target,at,sampledAt:now,lastSent:at,retries:0};pendingControls.set('volume',pending);deliver('volume',target,pending);
      window.watchFusionRoomSyncLog?.note?.('room-audio-reapplied',{volumePct:Math.round(target*100),reason:'source-track-volume'});
    }
    const pendingSeek = pendingControls.get('seek');
    const display = applyPendingControls(lastMetadata,sample);const confirmed=confirmTransportNotice(sample,now);if(!confirmed&&previous.pageUrl===sample.pageUrl&&previous.paused!==undefined&&previous.paused!==sample.paused)window.WatchFusionLinkedAcquisition?.confirmedTransport?.(sample,sample.paused?'pause':'play');
    window.WatchFusionPlaylistContinuity?.observe?.(sample,{eligible:!!(roomProof()&&isHost()),connected:peerReady(),pending:pendingControls.has('play'),send:()=>control('play',Number(sample.currentTime)||0)});
    const seekConfirmed = pendingSeek && !pendingControls.has('seek') &&
      Number(sample.sampledAt) >= pendingSeek.sampledAt && pendingSatisfied('seek',pendingSeek,sample);
    if (seekConfirmed) {
      window.WatchFusionLinkedAcquisition?.confirmedTransport?.(sample,'seek');seekMirrorDue={link,page:sample.pageUrl,at:now}; if(!pendingControls.has('play')&&!pendingControls.has('pause'))status(roomId?'Source seek confirmed · synchronizing room…':'Source seek confirmed · synchronizing playback…');
      window.watchFusionRoomSyncLog?.note?.('source-seek-confirmed',{positionMs:Math.round(sample.currentTime*1000),ackLatencyMs:Math.round(performance.now()-pendingSeek.at)});
    }
    renderControls(display);
    if(sample.tabMuted===false&&sample.paused===false)status('Linked tab is still playing sound · WatchFusion asked the extension to mute it. If you hear two copies, reload EveOS Bridge in chrome://extensions.');
    const pageUrl=String(lastMetadata.pageUrl||''); if(document.hidden&&backgroundLinkActive())window.WatchFusionZeroConverge?.sourceWake?.();
    if(pageUrl&&pageUrl!==loadedPageUrl){void followUrl(pageUrl);return;}
    const deliveryHold=window.WatchFusionSourceDelivery?.holdSteady?.(previous,sample,now,deliveryGap,!!seekConfirmed||confirmed||['seek','play','pause','rate'].some(a=>pendingControls.has(a)));if(deliveryHold){window.WatchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'source-post-gap-hold'});return;}if (!pendingControls.has('seek')) followLocal(display,!!seekConfirmed,lastMetadata);
    const forceSeek=seekMirrorDue?.link===link&&seekMirrorDue.page===pageUrl&&now>=seekMirrorDue.at&&now-seekMirrorDue.at<=SEEK_ACK_TTL_MS;if(!forceSeek||(!pendingControls.has('seek')&&!pendingControls.has('play')&&!pendingControls.has('pause')))seekMirrorDue=null;scheduleMirror(lastMetadata,!!forceSeek);
  }
  function connectPeer(){
    peer?.stop();if(!link)return;if(typeof navigationAgent!=='undefined')navigationAgent?.cancel();transitionPending=false;window.WatchFusionLinkedTransition?.reset?.();lastSampleAt=0;lastSampleUrl="";lastLinkedSampleAt=0;window.WatchFusionSourceDelivery?.reset?.();peerCreatedAt=performance.now();
    peer=new WatchFusionLivePeer({base:location.origin,id:link.id,token:link.publisherToken,roomId,memberId:session?.memberId,
      onStatus:message=>{if(typeof navigationAgent==='undefined'||!navigationAgent?.receive(message))status(message==='Source connected'?'Attached tab connected · matching media source…':message);},
      onMetadata,onClock:(pong,at)=>{const rtt=at-Number(pong.sentAt);if(rtt>=900&&rtt<=60000)window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'source-viewer-heartbeat-rtt',sampleAgeMs:Math.round(rtt)});},onReady:()=>{status('Linked transport connected · awaiting source confirmation…');replayQueued();}});
  }
  async function start(){
    if(roomId&&!isHost())return setStatus('Only the host can attach the room source.');
    if(active())return stop();
    if(state?.source?.kind==='live'&&state.source.mode==='audioflix')await window.unloadWatchFusionMedia?.();
    const startingRoom=roomId;
    const created=await post('/api/live',{});
    try {
      if(roomId!==startingRoom)throw new Error('Room changed while attaching source.');
      if(startingRoom)await bindRoom(created,startingRoom);
    } catch(error) {
      await post(`/api/live/${created.id}/stop`,created).catch(()=>{});
      setStatus(error.message);return false;
    }
    recoveryWindowAt=performance.now();recoveryCount=0;lastRecoveryAt=-Infinity;
    volumeRestorePage='';link=created;loadedPageUrl='';resolvingUrl='';pendingUrl='';lastMetadata={};lastMirrorAnchor=null;queuedMirror=null;pendingControls.clear();confirmedVolume=null;zeroVolumeSince=0;resolveRevision++;
    const pairing=new URL(location.origin);pairing.hash=`live=${created.id}.${created.publisherToken}`;
    $('livePairLink').value=pairing.href;$('livePairHelp').hidden=false;$('findMediaPanel').hidden=false;renderControls({});
    status('Pair the source tab. WatchFusion will resolve its URL and keep only playback state attached.');connectPeer();
  }
  async function stop(options={}){
    if(!link)return true;
    clearVolumeDraft();
    window.WatchFusionLinkedAcquisition?.reset?.();if(typeof navigationAgent!=='undefined')navigationAgent?.cancel();navigationNotice=null;const old=link;link=null;resolveRevision++;resolvingUrl='';pendingUrl='';loadedPageUrl='';lastMirrorAnchor=null;queuedMirror=null;pendingControls.clear();confirmedVolume=null;zeroVolumeSince=0;
    peer?.stop();peer=null;const stopped=await post(`/api/live/${old.id}/stop`,old).catch(()=>null);
    if(stopped?.state&&stopped.state.roomId===roomId&&applyIncomingRoomState(stopped.state))render();
    $('livePairHelp').hidden=true;restoreUi();if(!options.quiet)setStatus('Source tab unlinked · the page was restored to normal.');return true;
  }
  function reconnect(){if(!link)return start();mirrorGuard()?.reset?.();navigationNotice=null;window.WatchFusionLinkedAcquisition?.reset?.();window.watchFusionRoomSyncLog?.note?.('linked-acquisition',{reason:'manual-reconnect'});volumeRestorePage='';pendingControls.clear();confirmedVolume=null;zeroVolumeSince=0;lastMirrorAnchor=null;recoveryCount=0;lastRecoveryAt=-Infinity;connectPeer();status('Reconnecting source · refreshing controls…');return true;}
  $('linkTabBtn').onclick=()=>{void(active()?stop():start());};
  window.watchFusionLinkedTab={active,pinnedVolume,promoteToRoom,publishing:()=>!!(roomProof()&&state?.linkedSourceActive),applying:()=>transitionPending || applying || performance.now()<Math.max(playbackEchoUntil,soloRateEchoUntil,audioEchoUntil) || window.WatchFusionHostPeerRecovery?.suppressEcho?.()===true,soloCorrectionBlock,setApplying,suppressPlaybackEcho,control,queueVolume,start,stop,reconnect,render:renderControls,
    metadata:()=>lastMetadata,pendingControl:action=>active() &&
      performance.now() - (pendingControls.get(action)?.at ?? -Infinity) <= (action === 'volume' ? VOLUME_ECHO_TTL_MS : action === 'seek' ? SEEK_ACK_TTL_MS : CONTROL_ECHO_TTL_MS),
    soloEvidence:()=>({scope:link?.id,connected:peerReady(),matches:!transitionPending&&!!loadedPageUrl&&loadedPageUrl===lastMetadata.pageUrl&&soloResolvedKey===soloSourceKey(),pending:["seek","play","pause","rate"].some(a=>pendingControls.has(a))}), diagnostics:()=>({transport:lastTransportTiming,peerReady:peerReady(),recoveryCount,lastLinkedSampleAt,mirrorGuard:mirrorGuard()?.diagnostics?.()})};
})();
