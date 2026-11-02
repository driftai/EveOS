'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.provider.capture.js'),'utf8');

function fixture(overrides={}) {
  let sends = 0, pendingResolve = null, closeCount = 0, nativeStops = 0;
  const tracks = [];
  class Track {
    constructor(settings = { suppressLocalAudioPlayback:true }) { this.settings=settings;this.stopped=false;tracks.push(this); }
    getSettings(){return this.settings;}
    async applyConstraints(){}
    stop(){this.stopped=true;}
    addEventListener(){}
  }
  class Stream {
    constructor(tracks){this.tracks=tracks;}
    getAudioTracks(){return this.tracks.filter(x=>x.audio!==false);}
    getTracks(){return this.tracks;}
  }
  class Node {
    constructor(){this.port={onmessage:null,postMessage(){}};Node.instances.push(this);}
    connect(){return this;}
    disconnect(){}
  }
  Node.instances=[];
  class Context {
    constructor(){this.sampleRate=48000;this.destination={};this.audioWorklet={addModule:async()=>true};}
    async resume(){if(overrides.resumeFailure) throw new Error('AudioContext resume refused');}
    createMediaStreamSource(){return new Node();}
    createGain(){const n=new Node();n.gain={value:1};return n;}
    async close(){closeCount++;}
  }
  const window={AudioContext:Context,EveAudioflixCaptureProcessorSrc:'registerProcessor("audioflix-capture-processor",class{});',
    EveAudioflixState:{ensure:()=>({outputVolume:0.5})},
    EveAudioflixAudioBridge:{encodePcm:()=> 'AQI='},
    EveAudioflixNativeProviderCapture:{
      start:async()=>({sessionId:'t:1',captureToken:'secret',deviceId:'sd:7',endpointLabel:'CABLE',rendererRunning:true}),
      send:async()=>{sends++; if(overrides.deferSend) return new Promise(resolve=>pendingResolve=resolve); return {ok:true,deviceId:'sd:7',rendererRunning:true};},
      stop:async()=>{nativeStops++;return {ok:true};}
    },dispatchEvent(){},setTimeout,clearTimeout};
  const ctx={window,AudioWorkletNode:Node,MediaStream:Stream,navigator:{mediaDevices:{getDisplayMedia:overrides.getDisplayMedia}},
    CustomEvent:class {},setTimeout,clearTimeout,queueMicrotask,console};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  return {api:window.EveAudioflixProviderCapture,Track,Stream,Node,ctx,tracks,stats:()=>({sends,closeCount,nativeStops}),resolve:val=>pendingResolve?.(val)};
}
async function run(){
  const denied=fixture({getDisplayMedia:()=>Promise.reject(new Error('User cancelled chooser'))});
  await assert.rejects(denied.api.armProviderTab(),/User cancelled/);
  assert.strictEqual(denied.api.getStatus().state,'error','capture-chooser rejection must not remain requesting');

  const noAudio=fixture({getDisplayMedia:async()=>new noAudioStreamFixture()});
  function noAudioStreamFixture(){const video=new noAudio.Track(); video.audio=false;return new noAudio.Stream([video]);}
  await assert.rejects(noAudio.api.armProviderTab(),/Share tab audio/);
  assert(noAudio.tracks[0].stopped && noAudio.api.getStatus().state==='error','video-only capture must stop its track and report failure');

  const contextFailure=fixture({resumeFailure:true});const track=new contextFailure.Track();
  await assert.rejects(contextFailure.api.startStream(new contextFailure.Stream([track])),/resume refused/);
  assert(track.stopped && contextFailure.stats().closeCount===1,'resume error must close context and stop captured tracks');

  const delayed=fixture({deferSend:true});const captured=new delayed.Track();
  await delayed.api.startStream(new delayed.Stream([captured]));
  const node=delayed.Node.instances.find(n=>typeof n.port.onmessage==='function');assert(node);
  for(let i=0;i<4;i++){const data=new Float32Array(4096);data.fill(0.25);node.port.onmessage({data});}
  await new Promise(resolve=>setImmediate(resolve));
  assert.strictEqual(delayed.stats().sends,1,'a provider PCM request must be in flight');
  await delayed.api.stop('user');
  delayed.resolve({ok:true,deviceId:'sd:7',rendererRunning:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.strictEqual(delayed.api.getStatus().state,'idle','late PCM acknowledgment must never resurrect stopped capture');
  assert.strictEqual(delayed.api.getStatus().active,false);
  assert(captured.stopped && delayed.stats().nativeStops===1);

  // Edge Stop sharing can end the video track before the captured audio track.
  const edge=fixture();const edgeAudio=new edge.Track(),edgeVideo=new edge.Track();edgeVideo.audio=false;
  edgeAudio.handlers={};edgeVideo.handlers={};
  edgeAudio.addEventListener=function(name,fn){this.handlers[name]=fn;};
  edgeVideo.addEventListener=function(name,fn){this.handlers[name]=fn;};
  await edge.api.startStream(new edge.Stream([edgeAudio,edgeVideo]));
  edgeVideo.handlers.ended();
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.strictEqual(edge.stats().nativeStops,1,'video Stop sharing releases the native lane');
  assert.strictEqual(edge.api.getStatus().active,false,'capture is inactive after video sharing ends');

  const routing=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.ui.actions.routing.js'),'utf8');
  assert(routing.includes("'provider-managed-toggle', 'provider-managed-capture-toggle'")
    && routing.includes("'provider-retry'"), 'state-aware managed Spotify capture actions must preserve the trusted routing click path');
  const uiSource=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.provider.capture.ui.js'),'utf8');
  let presentation='hidden';const uiWindow={addEventListener(){},EveAudioflixSpotifyRemote:{snapshot:()=>({lastState:{managed:{presentation}}})}};
  vm.runInContext(uiSource,vm.createContext({window:uiWindow,document:{querySelectorAll:()=>[]},console}));
  const controls=uiWindow.EveAudioflixProviderCaptureUi.controls;
  assert.equal(controls({state:'error',active:false,source:'managed-spotify'}).retry,true);
  assert.equal(controls({state:'idle',active:false,source:'managed-spotify'}).showLabel,'Show Spotify Engine');
  presentation='window';assert.equal(controls({state:'capturing',active:true,source:'managed-spotify'}).showLabel,'Hide Spotify Engine');
  assert.equal(controls({state:'capturing',active:true,source:'managed-spotify'}).captureLabel,'Stop Engine Capture');
  assert.equal(controls({state:'requesting',active:false,source:'browser-tab'}).anotherLabel,'Choosing Provider Tab…');
  const commands=[];let pauses=0,statusReads=0;
  const item={id:'spotify:track:abc',title:'Managed song',type:'music',volume:0.5};
  const managedState={ok:true,isOwner:true,managed:{helperReachable:true,authState:'signed-in',presentation:'hidden',capture:{state:'capturing',active:true,nonzeroPcm:true,endpoint:'CABLE'}},engine:{status:'playing',paused:false,currentTime:12,duration:180}};
  const nexusWindow={
    EveAudioflixSpotifyRemote:{
      snapshot:()=>({connected:true,status:'ready',lastState:managedState,base:'http://127.0.0.1:8765'}),
      connect:async()=>({connected:true}),retry:async()=>({connected:true}),status:async()=>{statusReads++;return managedState;},
      send:async(action,payload)=>{commands.push({action,payload});return managedState;},openApproval:()=>true,disconnect(){}
    },
    EveAudioflixSpotifyAnyBrowser:{snapshot:()=>({active:true,item,playback:{item,paused:false}})},
    EveAudioflixProviderCaptureUi:{managedCaptureStatus:()=>managedState.managed.capture,armManagedSpotify:async()=>({ok:true})},
    EveAudioflixPlaybackPolicy:{resolve:()=>({spotifyMethod:'managed',outputKind:'native',outputId:'sd:7',outputLabel:'CABLE Input'})},
    EveAudioflixAudio:{pause:async()=>{pauses++;},playItem:async()=>true,stopAll:async()=>true},
    EveOSServiceReload:{restart:async()=>({serviceRestarted:true})}
  };
  const nexusContext=vm.createContext({window:nexusWindow,URL,Date,console});
  vm.runInContext(fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.spotify.management.js'),'utf8'),nexusContext);
  vm.runInContext(fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.nexus.spotify.js'),'utf8'),nexusContext);
  const markup=nexusWindow.EveAudioflixNexusSpotify.render();
  assert(markup.includes('Spotify Engine')&&markup.includes('signed-in')&&markup.includes('CABLE Input')&&markup.includes('Sign in / reauthenticate'),
    'Nexus projects authenticated engine, output and recovery controls');
  const actionCtx={playbackStatus:'',rerender(){}};
  await nexusWindow.EveAudioflixNexusSpotify.handleAction({dataset:{}},'nexus-spotify-refresh',actionCtx);
  await nexusWindow.EveAudioflixNexusSpotify.handleAction({dataset:{}},'nexus-spotify-auth',actionCtx);
  await nexusWindow.EveAudioflixNexusSpotify.handleAction({dataset:{}},'nexus-spotify-toggle',actionCtx);
  assert.equal(statusReads,1,'Nexus diagnostics use the authenticated relay status owner');
  assert.deepEqual(commands.map(entry=>entry.action),['take-control','auth'],
    'reauthentication retains relay ownership and uses the existing auth command');
  assert.equal(pauses,1,'Nexus pause delegates to the shared Audioflix playback owner');
  assert(routing.includes('EveAudioflixNexusSpotify?.handleAction'), 'Nexus Spotify actions retain the trusted routing click path');
  const nexusUi=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.nexus.ui.js'),'utf8');
  assert(nexusUi.includes('EveAudioflixNexusSpotify?.render'), 'Nexus music scope renders the management projection');
  console.log('AUDIOFLIX_PROVIDER_CAPTURE_RESILIENCE_OK chooser-denial no-audio resume-failure late-ack stopped-state gesture-preservation nexus-management');
}
run().catch(err=>{console.error(err);process.exitCode=1});
