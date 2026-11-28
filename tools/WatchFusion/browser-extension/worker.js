importScripts('eveos-hub-connector.js');
const asset = value => (globalThis.EveOSExtensionModuleRoots?.watchfusion || '') + value;
// Nested worker imports are relative to this module in standalone mode and are
// rooted by EveOS Bridge's module loader in the assembled extension.
importScripts('live-peer.js');

let sourceTab = null, controlFrameId = 0, statePeer = null;
let sourcePlayerSilenced = false;
let lastRefresh = 0, lastCombinedSample = null, lastSentSample = null, publisherReady = false;
let clockSamples = [];
// The acknowledgement window applies only after this server proves it supports receipts.
let deliverySeq=0, receiptReady=false, receiptRtt=null, deliveryDropped=0, deliveryRejected=0, deliveryPending=new Map(), lastDeliveryReconnect=-Infinity;
function resetDelivery(){deliverySeq=0;receiptReady=false;receiptRtt=null;deliveryDropped=deliveryRejected=0;deliveryPending.clear();rejectStreak=0;rejectSince=null;bufferSince=null;}
function receiveDeliveryReceipt(status,now=Date.now()){
  const m=/^wf-source-receipt\|(\d+)\|(accepted|rejected)$/.exec(String(status||''));if(!m)return false;
  const seq=Number(m[1]),at=deliveryPending.get(seq);if(at===undefined)return true;
  receiptReady=true;receiptRtt=Math.max(0,Math.min(60000,now-at));deliveryPending.delete(seq);if(m[2]==='rejected'){deliveryRejected=Math.min(1000000,deliveryRejected+1);rejectStreak++;rejectSince??=now;}else{rejectStreak=0;rejectSince=null;}return true;
}
function canPublishSource(peer,now,accountDrop=true){
  const socket=peer?.socket;if(!socketReady(peer))return false;
  const oldest=deliveryPending.values().next().value;
  if(receiptReady&&oldest!==undefined&&now-oldest>5000){retrySocket(peer,now,'source receipt timeout');return false;}
  // Sustained rejected fresh samples can mean a stale per-connection transit floor.
  // One reconnect per cooldown; an isolated reject is never a reason to reconnect.
  if(rejectStreak>=6&&rejectSince!==null&&now-rejectSince>=3000){
    if(retrySocket(peer,now,'source receipt rejection plateau'))return false;
  }
  if((socket?.bufferedAmount||0)>4096){
    bufferSince??=now;
    if(now-bufferSince>=10000)retrySocket(peer,now,'source socket backpressure timeout');
    if(accountDrop)deliveryDropped=Math.min(1000000,deliveryDropped+1);return false;
  }
  bufferSince=null;
  if(receiptReady&&deliveryPending.size>=2){if(accountDrop)deliveryDropped=Math.min(1000000,deliveryDropped+1);return false;}
  return !!peer;
}
let sourceOperation = Promise.resolve();
// A linked-only watchdog shares the existing serialized ownership lane. No alarm,
// tab reload, play/seek, permission expansion or new persistent service.
let watchdogTimer=null,watchdogQueued=false,probeCheckedAt=-Infinity,lastProbeAt=-Infinity;
let lastRecoveryAt=-Infinity,readySocket=null,unreadySince=null,rejectStreak=0,rejectSince=null,bufferSince=null;
let terminalStopPending=false,probeGeneration=null,sampleDrain=null,latestMuteEvidence=null;
const WATCHDOG_MS=2000,PROBE_STALE_MS=4000,REPAIR_COOLDOWN_MS=12000,MAX_PROBE_REPAIRS=3;
let repairAttempts=0;
function startWatchdog(){if(watchdogTimer===null)watchdogTimer=setInterval(scheduleWatchdog,WATCHDOG_MS);}
function stopWatchdog(){if(watchdogTimer!==null)clearInterval(watchdogTimer);watchdogTimer=null;}
function scheduleWatchdog(){
  if(watchdogQueued||terminalStopPending||!Number.isInteger(sourceTab))return;
  watchdogQueued=true;
  void withSourceOperation(recoverSource).catch(()=>{}).finally(()=>{watchdogQueued=false;});
}
function socketReady(peer=statePeer){return publisherReady&&!!peer&&(!peer.socket||(peer.socket===readySocket&&peer.socket.readyState===1));}
function retrySocket(peer,now,reason){
  const socket=peer?.socket;
  if(peer!==statePeer||!socket||![0,1].includes(socket.readyState)||now-lastDeliveryReconnect<30000)return false;
  lastDeliveryReconnect=now;publisherReady=false;readySocket=null;
  try{socket.close(4001,reason);return true;}catch{return false;}
}
async function recoverSource(){
  const tabId=sourceTab;if(terminalStopPending||!Number.isInteger(tabId))return;
  const now=Date.now();
  if(!statePeer||statePeer.closed){await restorePublisherIfNeeded(tabId);return;}
  const peer=statePeer;
  // No replacement publisher on ownership refusal. Existing peer owns reconnect.
  if(!socketReady(peer)){
    unreadySince??=now;
    if(now-unreadySince>=12000)retrySocket(peer,now,'source handshake timeout');
  }else{unreadySince=null;canPublishSource(peer,now,false);}
  if(now-lastProbeAt<PROBE_STALE_MS||now-lastRefresh<PROBE_STALE_MS||repairAttempts>=MAX_PROBE_REPAIRS)return;
  if(!(await ensureSourceTabMuted(tabId,true)))return;
  if(probeCheckedAt===-Infinity){
    probeCheckedAt=now;
    // A fresh sample, not the acknowledgement alone, proves the probe is alive.
    // Avoid holding the ownership queue on a suspended content script.
    const target=controlFrameId,generation=probeGeneration;
    void Promise.resolve().then(()=>chrome.tabs.sendMessage(tabId,{type:'probe-health',generation},{frameId:target})).catch(()=>{});
    return;
  }
  if(now-probeCheckedAt<3000||now-lastRefresh<REPAIR_COOLDOWN_MS)return;
  lastRefresh=now;probeCheckedAt=-Infinity;repairAttempts++;
  try{await inject(tabId);}catch{/* Retain pairing and mute; retry on a later qualified wake. */}
}
let probeRefreshes=0,probeRefreshSkipped=0,muteAudits=0;

// Serialize tab ownership, injection and mute writes. In-flight repairs must
// finish before unlink restores the original browser mute.
function withSourceOperation(operation) {
  const result = sourceOperation.then(operation);
  sourceOperation = result.catch(() => {});
  return result;
}

// v13.10.7: tab-level mute keeps the source's own volume/telemetry intact while WatchFusion is the only speaker.
// The old worker swallowed mute failures, so a still-audible source tab went unnoticed. Verify and re-assert.
let lastMuteAttemptAt=0, muteVerified=null;
async function ensureSourceTabMuted(tabId,force=false){
  if(!Number.isInteger(tabId)||sourceTab!==tabId)return false;
  const now=Date.now();
  if(!force&&now-lastMuteAttemptAt<4000)return muteVerified===true;
  lastMuteAttemptAt=now;muteAudits++;
  try{
    const before=await chrome.tabs.get(tabId);
    if(before?.mutedInfo?.muted!==true)await chrome.tabs.update(tabId,{muted:true});
    const after=await chrome.tabs.get(tabId);
    muteVerified=after?.mutedInfo?.muted===true;
  }catch(error){muteVerified=false;console.warn('WatchFusion: source tab mute failed:',String(error?.message||error));}
  return muteVerified===true;
}
const frameSamples = new Map();

function pairing(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Paste the private pairing link from WatchFusion.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Pairing link must use HTTP or HTTPS.');
  const match = url.hash.match(/^#live=([a-f\d-]{36})\.([a-f\d]{48})$/i);
  if (!match) throw new Error('That is not a WatchFusion source pairing link.');
  return { base:url.origin, id:match[1], token:match[2] };
}

async function messageFrames(tabId, message) {
  const frameIds = new Set([0, ...frameSamples.keys()]);
  return Promise.all([...frameIds].map(frameId => chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => {})));
}

async function cleanupInjected(tabId) {
  if (!Number.isInteger(tabId)) return;
  const run = async (world, globalName) => {
    const spec = { target:{ tabId, allFrames:true }, world,
      func:name => { try { globalThis[name]?.(); } catch {} }, args:[globalName] };
    try { await chrome.scripting.executeScript(spec); }
    catch { try { await chrome.scripting.executeScript({ ...spec, target:{ tabId } }); } catch {} }
  };
  await Promise.all([
    run('ISOLATED', '__watchFusionMediaProbeCleanup'),
    run('MAIN', '__watchFusionPageMediaAdapterCleanup')
  ]);
}

async function inject(tabId) {
  probeRefreshes++;lastRefresh=Date.now();probeGeneration=crypto.randomUUID();
  await cleanupInjected(tabId);
  frameSamples.clear(); controlFrameId = 0; lastCombinedSample = null; lastSentSample=null;lastProbeAt=-Infinity;
  let results;
  try {
    await chrome.scripting.executeScript({ target:{ tabId, allFrames:true }, world:'MAIN', files:[asset('source-page-adapter.js')] });
    results = await chrome.scripting.executeScript({ target:{ tabId, allFrames:true }, files:[asset('source-probe.js')] });
  } catch {
    await chrome.scripting.executeScript({ target:{ tabId }, world:'MAIN', files:[asset('source-page-adapter.js')] });
    results = await chrome.scripting.executeScript({ target:{ tabId }, files:[asset('source-probe.js')] });
  }
  results.forEach(result => { if (!frameSamples.has(result.frameId)) frameSamples.set(result.frameId, null); });
  await messageFrames(tabId, { type:'probe-start', sourcePlayerSilenced, generation:probeGeneration });
}

// A healthy top-level media probe must not be torn down for unrelated iframe loads.
function healthyTopProbe(tabId, pageUrl) {
  const top=frameSamples.get(0), age=Date.now()-Number(top?.metadata?.sampledAt);
  let direct=false;try{const u=new URL(pageUrl);direct=/^(?:(?:www|m)\.)?youtube\.com$/i.test(u.hostname)&&u.pathname==='/watch'&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')||'');}catch{}
  return direct && sourceTab===tabId && publisherReady && controlFrameId===0 && top?.topFrame===true && top.hasMedia===true && !top.metadata?.status && !!pageUrl && top.metadata?.pageUrl===pageUrl && age>=0 && age<=900;
}
function directVideo(url){try{const u=new URL(url);return /^(?:(?:www|m)\.)?youtube\.com$/i.test(u.hostname)&&u.pathname==='/watch'&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')||'')?u.searchParams.get('v'):null;}catch{return null;}}
function combinedSample(frameId, message, pageUrl = '') {
  const at=Date.now(), stamp=message.metadata?.sampledAt, sampleAge=at-stamp;
  if(!Number.isFinite(stamp)||stamp<=0||sampleAge<0||sampleAge>900)return lastCombinedSample;
  const prior=frameSamples.get(frameId), direct=directVideo(pageUrl);
  // Never relabel old-document media with a new top-level YouTube identity.
  if(direct&&message.topFrame===true&&directVideo(message.metadata?.pageUrl)!==direct){lastCombinedSample=null;return null;}
  if(Number.isFinite(prior?.metadata?.sampledAt)&&stamp<=prior.metadata.sampledAt)return lastCombinedSample;
  if(!direct||message.topFrame===true){lastProbeAt=at;probeCheckedAt=-Infinity;repairAttempts=0;}
  frameSamples.set(frameId, { ...message, frameId, publisherReceivedAt:at });
  const fresh=[...frameSamples.values()].filter(value=>value&&Date.now()-value.publisherReceivedAt<1800&&(!Number.isFinite(value.metadata?.sampledAt)||(Date.now()-value.metadata.sampledAt>=0&&Date.now()-value.metadata.sampledAt<1800)));
  const top=fresh.find(value=>value.topFrame&&(!direct||directVideo(value.metadata?.pageUrl)===direct));
  const media=direct ? (top?.hasMedia?top:null) : fresh.filter(value=>value.hasMedia).sort((a,b)=>b.score-a.score)[0];
  if(media)controlFrameId=media.frameId;
  const metadata=media?.metadata||top?.metadata||{};
  lastCombinedSample={metadata:{...metadata,pageUrl:String(pageUrl||metadata.pageUrl||''),publisherReceivedAt:media?.publisherReceivedAt??top?.publisherReceivedAt??Date.now(),
    status:media?(metadata.status||''):'Waiting for playable media · enable Setup & embedded players access for embedded video.'}};
  return lastCombinedSample;
}

async function waitForInitialSample(timeoutMs=1200) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(lastCombinedSample?.metadata?.pageUrl)return lastCombinedSample;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  return lastCombinedSample;
}

async function restoreSourceTab(tabId, previousMuted) {
  if(!Number.isInteger(tabId))return;
  await messageFrames(tabId,{type:'probe-stop'});
  await cleanupInjected(tabId);
  if(typeof previousMuted==='boolean')await chrome.tabs.update(tabId,{muted:previousMuted}).catch(()=>{});
}

async function forwardControl(action,value,expectedPeer=null) {
  const tabId=sourceTab??(await chrome.storage.session.get('sourceTab')).sourceTab;
  const navigation=action==='next'||action==='prev';
  if(!Number.isInteger(tabId))return {outcome:'rejected',reason:'no-source-tab'};
  let frameId=controlFrameId;
  if(navigation){try{const tab=await chrome.tabs.get(tabId),u=new URL(tab.url);if(/^(?:(?:www|m)\.)?youtube\.com$/i.test(u.hostname))frameId=0;}catch{return {outcome:'rejected',reason:'source-tab-unavailable'};}}
  if(expectedPeer&&(statePeer!==expectedPeer||sourceTab!==tabId))return {outcome:'rejected',reason:'source-link-changed'};
  try {const result=await chrome.tabs.sendMessage(tabId,{type:'source-control',action,value,generation:probeGeneration},{frameId});
    if(navigation)return ['accepted','rejected','unknown'].includes(result?.outcome)?result:{outcome:'unknown',reason:'no-execution-ack'};
    return result;
  } catch {return navigation?{outcome:'unknown',reason:'probe-delivery-error'}:undefined;}
}

function updatePublisherClock({sentAt, receivedAt, serverTime}, localAt) {
  if (![sentAt, receivedAt, serverTime, localAt].every(Number.isFinite) || serverTime < receivedAt) return;
  if (clockSamples.length && Math.abs(localAt - clockSamples.at(-1).at) > 15000) clockSamples = [];
  const rtt = localAt - sentAt - (serverTime - receivedAt);
  if (rtt < 0 || rtt > 220) return;
  const offset = ((receivedAt - sentAt) + (serverTime - localAt)) / 2;
  if (clockSamples.length && Math.abs(offset - clockSamples.at(-1).offset) > 180) clockSamples = [];
  clockSamples = [...clockSamples.filter(item => localAt - item.at <= 12000), {offset,rtt,at:localAt}].slice(-5);
}
function sendSourceSample(sample, tabMuted) {
  const now = Date.now(), age=now-Number(sample.sampledAt);
  if(!Number.isFinite(age)||Number(sample.sampledAt)<=0||age<0||age>900)return false;
  const valid = clockSamples.filter(item => now - item.at <= 12000).sort((a,b) => a.rtt - b.rtt);
  const best = valid[0];
  const close = best ? valid.filter(item => item.rtt <= best.rtt + 12) : [];
  const offsets = close.map(item => item.offset).sort((a,b) => a-b);
  const uncertaintyMs = best ? best.rtt / 2 + (offsets.at(-1) - offsets[0]) + 8 : Infinity;
  const clock = close.length >= 3 && uncertaintyMs <= 125 && sample.sampledAt > 0 && now - sample.sampledAt >= 0 && now - sample.sampledAt <= 1500
    ? {serverSampledAt:sample.sampledAt + offsets[Math.floor(offsets.length / 2)], uncertaintyMs} : {};
  const peer=statePeer;if(!canPublishSource(peer,now))return false;
  const seq=++deliverySeq;
  // Only an actual socket enqueue may consume the acknowledgement window.
  const sent=peer.send({type:'metadata',metadata:{...sample, ...clock, probeRefreshes,probeRefreshSkipped,muteAudits,deliverySeq:seq,publisherBufferBytes:Math.min(1000000,Math.max(0,Math.round(peer.socket?.bufferedAmount||0))),publisherSkipped:deliveryDropped,publisherRejected:deliveryRejected,...(receiptRtt!==null?{publisherAckRttMs:receiptRtt}:{}), ...(typeof tabMuted === 'boolean' ? {tabMuted} : {}), sourcePlayerSilenced, publisherSentAt:now}});
  if(sent!==true){deliveryDropped=Math.min(1000000,deliveryDropped+1);return false;}
  deliveryPending.set(seq,now);while(deliveryPending.size>16)deliveryPending.delete(deliveryPending.keys().next().value);return true;
}

function connectStatePublisher(config) {
  statePeer?.stop();
  publisherReady=false;readySocket=null;unreadySince=Date.now();clockSamples=[];lastSentSample=null;resetDelivery();
  let peer=null, earlyReady=false;
  const onReady=()=>{
    if(!peer){earlyReady=true;return;}
    if(statePeer!==peer)return;
    publisherReady=true;readySocket=peer.socket??null;unreadySince=null;lastSentSample=null;clockSamples=[];resetDelivery();
    if(lastCombinedSample?.metadata&&sendSourceSample(lastCombinedSample.metadata,muteVerified===true))lastSentSample=lastCombinedSample;
  };
  peer=new WatchFusionLivePeer({
    base:config.base,id:config.id,token:config.token,publisher:true,onReady,
    onClock:(sample,at)=>{if(statePeer===peer&&socketReady(peer))updatePublisherClock(sample,at);},
    onControl:(action,value)=>peer&&statePeer===peer?forwardControl(action,value,peer).then(result=>{
      if(statePeer===peer&&['next','prev'].includes(action)&&Number.isSafeInteger(value)&&value>0){const outcome=result?.outcome||'unknown';peer.send({type:'navigation-result',action,value,outcome,reason:result?.reason||'no-execution-ack',target:result?.target||'',index:result?.index||0});}
    }).catch(()=>{if(statePeer===peer&&['next','prev'].includes(action)&&Number.isSafeInteger(value)&&value>0)peer.send({type:'navigation-result',action,value,outcome:'unknown',reason:'probe-delivery-error'});}):undefined,
    onStatus:status=>{
      if(!peer||statePeer!==peer||receiveDeliveryReceipt(status))return;
      if(/stopped|expired|denied|replaced/i.test(String(status||''))) {
        terminalStopPending=true;publisherReady=false;readySocket=null;peer.stop();
        void withSourceOperation(()=>statePeer===peer && stop());
      }else if(peer.socket&&peer.socket.readyState!==1){publisherReady=false;readySocket=null;unreadySince??=Date.now();}
    }
  });
  statePeer=peer;
  if(earlyReady)onReady();
}

async function restorePublisherIfNeeded(expectedTabId) {
  if(terminalStopPending)return false;
  if(statePeer&&!statePeer.closed)return expectedTabId==null || sourceTab===expectedTabId;
  const saved=await chrome.storage.session.get(['sourceTab','sourceLinkConfig','sourcePlayerSilenced']);
  if(!Number.isInteger(saved.sourceTab)||!saved.sourceLinkConfig)return false;
  if(expectedTabId!=null && saved.sourceTab!==expectedTabId)return false;
  sourceTab=saved.sourceTab;
  sourcePlayerSilenced=saved.sourcePlayerSilenced===true;
  startWatchdog();
  if(Date.now()-lastRecoveryAt<REPAIR_COOLDOWN_MS||repairAttempts>=MAX_PROBE_REPAIRS)return false;
  lastRecoveryAt=Date.now();repairAttempts++;
  try {
    const tab=await chrome.tabs.get(sourceTab);
    if(!(await ensureSourceTabMuted(sourceTab,true)))throw new Error('Source tab mute could not be verified during restore.');
    await inject(sourceTab);
    lastCombinedSample??={metadata:{pageUrl:String(tab.url||'')}};
    connectStatePublisher(saved.sourceLinkConfig);
    return true;
  } catch { /* Transient restore failure is not an explicit unlink. */ return false; }
}

async function stop() {
  const saved=await chrome.storage.session.get(['sourceTab','sourceTabWasMuted']);
  const tabId=sourceTab??saved.sourceTab;
  stopWatchdog();publisherReady=false;readySocket=null;unreadySince=null;probeGeneration=null;latestMuteEvidence=null;statePeer?.stop();statePeer=null;
  lastProbeAt=probeCheckedAt=lastRecoveryAt=lastRefresh=lastDeliveryReconnect=-Infinity;repairAttempts=0;resetDelivery();
  await restoreSourceTab(tabId,saved.sourceTabWasMuted);
  sourceTab=null;sourcePlayerSilenced=false;muteVerified=null;lastMuteAttemptAt=0;probeRefreshes=probeRefreshSkipped=muteAudits=0;frameSamples.clear();controlFrameId=0;lastCombinedSample=null;lastSentSample=null;
  await chrome.storage.session.remove(['sourceTab','sourceTabWasMuted','sourceLinkConfig','sourcePlayerSilenced']);
  terminalStopPending=false;
  return {ok:true};
}

async function startCurrentTab(value,options={}) {
  const config=pairing(value);
  const windowFilter=Number.isInteger(options.windowId) && options.windowId>0
    ? {windowId:options.windowId} : {currentWindow:true};
  const [active]=await chrome.tabs.query({active:true,...windowFilter});
  const tabId=options.tabId??active?.id;
  if(!Number.isInteger(tabId)||active?.id!==tabId)throw new Error('Return to the source tab before linking it.');
  await stop();
  try{
    const tab=await chrome.tabs.get(tabId);sourceTab=tabId;
    await chrome.storage.session.set({sourceTab,sourceTabWasMuted:!!tab?.mutedInfo?.muted,sourceLinkConfig:config});
    if(!(await ensureSourceTabMuted(tabId,true)))throw new Error('Source tab mute failed; pairing refused. Check EveOS Bridge tab permissions.');
    await inject(tabId);
    const initial=await waitForInitialSample();
    if(initial?.metadata)lastCombinedSample=initial;
    connectStatePublisher(config);startWatchdog();
    return {ok:true,message:'Current tab linked to WatchFusion state/control.'};
  }catch(error){await stop();throw error;}
}

async function setSourcePlayerSilence(tabId, enabled) {
  if (!Number.isInteger(tabId) || typeof enabled !== 'boolean' || !(await restorePublisherIfNeeded(tabId))) {
    return {error:'Open EveOS Bridge on the linked source tab.'};
  }
  await chrome.storage.session.set({sourcePlayerSilenced:enabled});
  sourcePlayerSilenced=enabled;
  const responses=await messageFrames(tabId,{type:'source-player-silence',enabled,generation:probeGeneration});
  const silencedMedia=responses.reduce((total,response)=>total+(response?.silencedMedia||0),0);
  return {ok:true,sourcePlayerSilenced,silencedMedia};
}

globalThis.WatchFusionMediaLink=Object.freeze({
  pairing,
  startCurrentTab:(...args)=>withSourceOperation(()=>startCurrentTab(...args)),
  stop:()=>withSourceOperation(stop),
  setSourcePlayerSilence:(...args)=>withSourceOperation(()=>setSourcePlayerSilence(...args)),
  status:({verifyMute=false}={})=>withSourceOperation(async()=>{
    if(!(await restorePublisherIfNeeded()))return {linked:false};
    const tabMuted=verifyMute ? await ensureSourceTabMuted(sourceTab,true) : muteVerified===true;
    return {linked:true,sourceTabId:sourceTab,tabMuted,sourcePlayerSilenced,relayVideoMode:'state-only',captureSettings:null,diagnostics:[]};
  })
});

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message.to!=='worker')return;
  (async()=>{
    const internal=sender.id===chrome.runtime.id;
    if(message.type==='preview-pairing'&&internal)return {ok:true,...pairing(message.pairing)};
    if(message.type==='status'&&internal)return globalThis.WatchFusionMediaLink.status({verifyMute:message.verifyMute===true&&!sender.tab});
    if(message.type==='runtime-status'&&internal)return globalThis.WatchFusionHubConnector?.serviceStatus?.()||{online:false,exposureMode:null,mode:'Offline'};
    if(message.type==='start-pairing'&&internal&&!sender.tab)return globalThis.WatchFusionMediaLink.startCurrentTab(message.pairing,{tabId:message.tabId,windowId:message.windowId});
    if(message.type==='stop'&&internal&&!sender.tab)return globalThis.WatchFusionMediaLink.stop();
    if(message.type==='source-player-silence'&&internal&&!sender.tab)return globalThis.WatchFusionMediaLink.setSourcePlayerSilence(message.tabId,message.enabled);
    const tabId=sourceTab??(await chrome.storage.session.get('sourceTab')).sourceTab;
    if(message.type==='refresh-probes'&&internal&&tabId!=null&&(!sender.tab||sender.tab.id===tabId)){
      return withSourceOperation(async()=>{
        if(healthyTopProbe(tabId,sender.tab?.url)){probeRefreshSkipped++;return {ok:true,skipped:true};}
        if(Date.now()-lastRefresh>1000 && await restorePublisherIfNeeded(tabId) && Date.now()-lastRefresh>1000){
          lastRefresh=Date.now();
          await inject(tabId);
        }
        return {ok:true};
      });
    }
    if(message.type==='sample'&&internal&&sender.tab?.id===tabId){
      const receivedAt=Date.now();
      // Initial, old-document and old-injection samples cannot become the
      // active reference. A cold worker may still restore its saved pairing.
      if(probeGeneration&&message.generation===probeGeneration)combinedSample(sender.frameId||0,message,sender.tab?.url||'');
      latestMuteEvidence={tabId,at:receivedAt,muted:sender.tab?.mutedInfo?.muted};
      if(sampleDrain)return sampleDrain;
      const task=withSourceOperation(async()=>{
        if(!(await restorePublisherIfNeeded(tabId))||!socketReady())return {ok:true,pending:true};
        const evidence=latestMuteEvidence,age=Date.now()-Number(evidence?.at);
        const fresh=evidence?.tabId===tabId&&age>=0&&age<=900;
        if(fresh&&muteVerified===true&&evidence.muted===true)lastMuteAttemptAt=Date.now();
        const muted=await ensureSourceTabMuted(tabId,fresh&&evidence.muted===false);
        const sample=lastCombinedSample;if(!sample||sample===lastSentSample||sourceTab!==tabId||!socketReady()||Number.isFinite(sample.metadata.sampledAt)&&sample.metadata.sampledAt===lastSentSample?.metadata?.sampledAt&&sample.metadata.pageUrl===lastSentSample?.metadata?.pageUrl)return {ok:true,superseded:true};
        const sampleAge=Date.now()-Number(sample.metadata.sampledAt);if(!Number.isFinite(sampleAge)||sampleAge<0||sampleAge>900)return {ok:true,stale:true};
        if(sendSourceSample(sample.metadata,muted))lastSentSample=sample;return {ok:true};
      });
      sampleDrain=task;
      void task.finally(()=>{if(sampleDrain===task)sampleDrain=null;}).catch(()=>{});
      return task;
    }
    return {error:'No selected media tab.'};
  })().then(reply,error=>reply({error:error.message,code:error.code}));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId=>withSourceOperation(async()=>{
  const selected=sourceTab??(await chrome.storage.session.get('sourceTab')).sourceTab;
  if(tabId===selected)await stop();
}));
chrome.tabs.onUpdated.addListener((tabId,info)=>{
  const needsVerification=info.mutedInfo?.muted===false || info.status==='complete' || info.audible===true;
  if(!needsVerification)return;
  return withSourceOperation(async()=>{
    // A tab event can wake the worker before in-memory ownership is restored.
    if(info.status==='complete'&&sourceTab===tabId){repairAttempts=0;lastRecoveryAt=-Infinity;}
    if(!statePeer || statePeer.closed)return restorePublisherIfNeeded(tabId);
    if(sourceTab!==tabId)return;
    const muted=await ensureSourceTabMuted(tabId,true);
    if(info.status!=='complete')return;
    try{
      if(!muted)return;
      await inject(tabId);
    }catch{/* Preserve the selected tab and retry through the linked watchdog. */}
  });
});

/* Runtime activation witness: captured only after this module has loaded. */
(() => {
  const root = globalThis.EveOSExtensionModuleRoots?.watchfusion;
  const build = globalThis.EveOSExtensionModuleBuilds?.watchfusion;
  if (root !== 'modules/watchfusion/' || !/^[a-f0-9]{64}$/.test(build || '') ||
      typeof globalThis.WatchFusionMediaLink?.startCurrentTab !== 'function' ||
      typeof globalThis.WatchFusionLivePeer !== 'function') return;
  const instance = crypto.randomUUID();
  const extensionId = chrome.runtime.id;
  const version = chrome.runtime.getManifest().version;
  Object.defineProperty(globalThis, 'WatchFusionActivationWitness', { configurable: false, writable: false,
    value: async nonce => {
      if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) return null;
      const hashes = {};
      for (const file of ['worker.js', 'source-probe.js', 'live-peer.js']) {
        const response = await fetch(chrome.runtime.getURL(root + file), { cache: 'no-store' });
        if (!response.ok) throw new Error('activation asset unavailable');
        const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
        hashes[file] = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      }
      const saved = await chrome.storage.session.get(['sourceTab', 'sourceLinkConfig']);
      return { schema: 1, nonce, extensionId, version, build, instance, hashes,
        loaded: true, linked: Number.isInteger(sourceTab) || !!saved.sourceLinkConfig || Number.isInteger(saved.sourceTab) };
    }
  });
})();
