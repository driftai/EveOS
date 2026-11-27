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
function resetDelivery(){deliverySeq=0;receiptReady=false;receiptRtt=null;deliveryDropped=deliveryRejected=0;deliveryPending.clear();}
function receiveDeliveryReceipt(status,now=Date.now()){
  const m=/^wf-source-receipt\|(\d+)\|(accepted|rejected)$/.exec(String(status||''));if(!m)return false;
  const seq=Number(m[1]),at=deliveryPending.get(seq);if(at===undefined)return true;
  receiptReady=true;receiptRtt=Math.max(0,Math.min(60000,now-at));deliveryPending.delete(seq);if(m[2]==='rejected')deliveryRejected=Math.min(1000000,deliveryRejected+1);return true;
}
function canPublishSource(peer,now){
  const socket=peer?.socket;if(socket&&socket.readyState!==1)return false;
  const oldest=deliveryPending.values().next().value;
  if(receiptReady&&oldest!==undefined&&now-oldest>5000&&now-lastDeliveryReconnect>30000&&socket?.readyState===1){lastDeliveryReconnect=now;socket.close(4001,'source receipt timeout');return false;}
  if((socket?.bufferedAmount||0)>4096||receiptReady&&deliveryPending.size>=2){deliveryDropped=Math.min(1000000,deliveryDropped+1);return false;}
  return !!peer;
}
let sourceOperation = Promise.resolve();
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
  probeRefreshes++;
  await cleanupInjected(tabId);
  frameSamples.clear(); controlFrameId = 0; lastCombinedSample = null; lastSentSample=null;
  let results;
  try {
    await chrome.scripting.executeScript({ target:{ tabId, allFrames:true }, world:'MAIN', files:[asset('source-page-adapter.js')] });
    results = await chrome.scripting.executeScript({ target:{ tabId, allFrames:true }, files:[asset('source-probe.js')] });
  } catch {
    await chrome.scripting.executeScript({ target:{ tabId }, world:'MAIN', files:[asset('source-page-adapter.js')] });
    results = await chrome.scripting.executeScript({ target:{ tabId }, files:[asset('source-probe.js')] });
  }
  results.forEach(result => { if (!frameSamples.has(result.frameId)) frameSamples.set(result.frameId, null); });
  await messageFrames(tabId, { type:'probe-start', sourcePlayerSilenced });
}

// A healthy top-level media probe must not be torn down for unrelated iframe loads.
function healthyTopProbe(tabId, pageUrl) {
  const top=frameSamples.get(0), age=Date.now()-Number(top?.metadata?.sampledAt);
  let direct=false;try{const u=new URL(pageUrl);direct=/^(?:(?:www|m)\.)?youtube\.com$/i.test(u.hostname)&&u.pathname==='/watch'&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')||'');}catch{}
  return direct && sourceTab===tabId && publisherReady && controlFrameId===0 && top?.topFrame===true && top.hasMedia===true && !top.metadata?.status && !!pageUrl && top.metadata?.pageUrl===pageUrl && age>=0 && age<=900;
}
function combinedSample(frameId, message, pageUrl = '') {
  const sampleAge=Date.now()-Number(message.metadata?.sampledAt);if(Number.isFinite(sampleAge)&&(sampleAge<0||sampleAge>900))return lastCombinedSample;
  frameSamples.set(frameId, { ...message, frameId, publisherReceivedAt:Date.now() });
  const fresh=[...frameSamples.values()].filter(value=>value&&Date.now()-value.publisherReceivedAt<1800&&(!Number.isFinite(value.metadata?.sampledAt)||(Date.now()-value.metadata.sampledAt>=0&&Date.now()-value.metadata.sampledAt<1800)));
  const media=fresh.filter(value=>value.hasMedia).sort((a,b)=>b.score-a.score)[0];
  const top=fresh.find(value=>value.topFrame);
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
  try {const result=await chrome.tabs.sendMessage(tabId,{type:'source-control',action,value},{frameId});
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
  if(Number.isFinite(age)&&(age<0||age>900))return false;
  const valid = clockSamples.filter(item => now - item.at <= 12000).sort((a,b) => a.rtt - b.rtt);
  const best = valid[0];
  const close = best ? valid.filter(item => item.rtt <= best.rtt + 12) : [];
  const offsets = close.map(item => item.offset).sort((a,b) => a-b);
  const uncertaintyMs = best ? best.rtt / 2 + (offsets.at(-1) - offsets[0]) + 8 : Infinity;
  const clock = close.length >= 3 && uncertaintyMs <= 125 && sample.sampledAt > 0 && now - sample.sampledAt >= 0 && now - sample.sampledAt <= 1500
    ? {serverSampledAt:sample.sampledAt + offsets[Math.floor(offsets.length / 2)], uncertaintyMs} : {};
  const peer=statePeer;if(!canPublishSource(peer,now))return false;
  const seq=++deliverySeq;deliveryPending.set(seq,now);while(deliveryPending.size>16)deliveryPending.delete(deliveryPending.keys().next().value);
  // An attempted send is not receipt evidence. Only the matching server result qualifies it.
  peer.metadata({...sample, ...clock, probeRefreshes,probeRefreshSkipped,muteAudits,deliverySeq:seq,publisherBufferBytes:Math.min(1000000,Math.max(0,Math.round(peer.socket?.bufferedAmount||0))),publisherSkipped:deliveryDropped,publisherRejected:deliveryRejected,...(receiptRtt!==null?{publisherAckRttMs:receiptRtt}:{}), ...(typeof tabMuted === 'boolean' ? {tabMuted} : {}), sourcePlayerSilenced, publisherSentAt:now});return true;
}

function connectStatePublisher(config) {
  statePeer?.stop();
  publisherReady=false;clockSamples=[];lastSentSample=null;resetDelivery();
  let peer=null, earlyReady=false;
  const onReady=()=>{
    if(!peer){earlyReady=true;return;}
    if(statePeer!==peer)return;
    publisherReady=true;resetDelivery();
    if(lastCombinedSample?.metadata&&sendSourceSample(lastCombinedSample.metadata,muteVerified===true))lastSentSample=lastCombinedSample;
  };
  peer=new WatchFusionLivePeer({
    base:config.base,id:config.id,token:config.token,publisher:true,onReady,
    onClock:updatePublisherClock,
    onControl:(action,value)=>peer&&statePeer===peer?forwardControl(action,value,peer).then(result=>{
      if(statePeer===peer&&['next','prev'].includes(action)&&Number.isSafeInteger(value)&&value>0){const outcome=result?.outcome||'unknown';peer.send({type:'navigation-result',action,value,outcome,reason:result?.reason||'no-execution-ack',target:result?.target||'',index:result?.index||0});}
    }).catch(()=>{if(statePeer===peer&&['next','prev'].includes(action)&&Number.isSafeInteger(value)&&value>0)peer.send({type:'navigation-result',action,value,outcome:'unknown',reason:'probe-delivery-error'});}):undefined,
    onStatus:status=>{
      if(!peer||statePeer!==peer||receiveDeliveryReceipt(status))return;
      if(/stopped|expired|denied|replaced/i.test(String(status||''))) {
        void withSourceOperation(()=>statePeer===peer && stop());
      }
    }
  });
  statePeer=peer;
  if(earlyReady)onReady();
}

async function restorePublisherIfNeeded(expectedTabId) {
  if(statePeer&&!statePeer.closed)return expectedTabId==null || sourceTab===expectedTabId;
  const saved=await chrome.storage.session.get(['sourceTab','sourceLinkConfig','sourcePlayerSilenced']);
  if(!Number.isInteger(saved.sourceTab)||!saved.sourceLinkConfig)return false;
  if(expectedTabId!=null && saved.sourceTab!==expectedTabId)return false;
  sourceTab=saved.sourceTab;
  sourcePlayerSilenced=saved.sourcePlayerSilenced===true;
  try {
    const tab=await chrome.tabs.get(sourceTab);
    if(!(await ensureSourceTabMuted(sourceTab,true)))throw new Error('Source tab mute could not be verified during restore.');
    await inject(sourceTab);
    lastCombinedSample??={metadata:{pageUrl:String(tab.url||'')}};
    connectStatePublisher(saved.sourceLinkConfig);
    return true;
  } catch { await stop(); return false; }
}

async function stop() {
  const saved=await chrome.storage.session.get(['sourceTab','sourceTabWasMuted']);
  const tabId=sourceTab??saved.sourceTab;
  publisherReady=false;statePeer?.stop();statePeer=null;
  await restoreSourceTab(tabId,saved.sourceTabWasMuted);
  sourceTab=null;sourcePlayerSilenced=false;muteVerified=null;lastMuteAttemptAt=0;probeRefreshes=probeRefreshSkipped=muteAudits=0;frameSamples.clear();controlFrameId=0;lastCombinedSample=null;lastSentSample=null;
  await chrome.storage.session.remove(['sourceTab','sourceTabWasMuted','sourceLinkConfig','sourcePlayerSilenced']);
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
    connectStatePublisher(config);
    return {ok:true,message:'Current tab linked to WatchFusion state/control.'};
  }catch(error){await stop();throw error;}
}

async function setSourcePlayerSilence(tabId, enabled) {
  if (!Number.isInteger(tabId) || typeof enabled !== 'boolean' || !(await restorePublisherIfNeeded(tabId))) {
    return {error:'Open EveOS Bridge on the linked source tab.'};
  }
  await chrome.storage.session.set({sourcePlayerSilenced:enabled});
  sourcePlayerSilenced=enabled;
  const responses=await messageFrames(tabId,{type:'source-player-silence',enabled});
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
        if(Date.now()-lastRefresh>1000 && await restorePublisherIfNeeded(tabId)){
          lastRefresh=Date.now();
          await inject(tabId);
        }
        return {ok:true};
      });
    }
    if(message.type==='sample'&&sender.tab?.id===tabId){
      const receivedAt=Date.now();
      combinedSample(sender.frameId||0,message,sender.tab?.url||'');
      return withSourceOperation(async()=>{
        if(!(await restorePublisherIfNeeded(tabId))||!publisherReady)return {ok:true,pending:true};
        // Native sender.tab mute metadata is browser-owned. Fresh positive evidence
        // avoids a pair of redundant tabs.get round trips; explicit unmute still forces readback.
        if(sourceTab===tabId&&muteVerified===true&&sender.tab?.mutedInfo?.muted===true&&Date.now()-receivedAt>=0&&Date.now()-receivedAt<=900)lastMuteAttemptAt=Date.now();
        const muted=await ensureSourceTabMuted(tabId,sender.tab?.mutedInfo?.muted===false);
        // Coalesce queued delivery to the freshest known sample, not the callback's old sample.
        const sample=lastCombinedSample;if(!sample||sample===lastSentSample||sourceTab!==tabId||!publisherReady||Number.isFinite(sample.metadata.sampledAt)&&sample.metadata.sampledAt===lastSentSample?.metadata?.sampledAt&&sample.metadata.pageUrl===lastSentSample?.metadata?.pageUrl)return {ok:true,superseded:true};
        const age=Date.now()-Number(sample.metadata.sampledAt);if(Number.isFinite(age)&&(age<0||age>900))return {ok:true,stale:true};
        if(sendSourceSample(sample.metadata,muted))lastSentSample=sample;return {ok:true};
      });
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
    if(!statePeer || statePeer.closed)return restorePublisherIfNeeded(tabId);
    if(sourceTab!==tabId)return;
    const muted=await ensureSourceTabMuted(tabId,true);
    if(info.status!=='complete')return;
    try{
      if(!muted)throw new Error('Mute failed after navigation');
      await inject(tabId);
    }catch{await stop();}
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
