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

  const routing=fs.readFileSync(path.join(root,'js/modules/features/audioflix/audioflix.ui.actions.routing.js'),'utf8');
  assert(routing.includes("'provider-managed-show', 'provider-managed-arm'"), 'managed Spotify capture actions must preserve the trusted routing click path');
  console.log('AUDIOFLIX_PROVIDER_CAPTURE_RESILIENCE_OK chooser-denial no-audio resume-failure late-ack stopped-state gesture-preservation');
}
run().catch(err=>{console.error(err);process.exitCode=1});
