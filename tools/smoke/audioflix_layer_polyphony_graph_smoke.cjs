'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const repo = process.argv[2] || path.resolve(__dirname, '..', '..');
const waveformSource = fs.readFileSync(path.join(repo,'js/modules/features/audioflix/audioflix.audio.waveform.js'),'utf8');
const layerSource = fs.readFileSync(path.join(repo,'js/modules/features/audioflix/audioflix.audio.layers.js'),'utf8');
const providerLayerSource = fs.readFileSync(path.join(repo,'js/modules/features/audioflix/audioflix.audio.provider-layers.js'),'utf8');
class FakeNode {
  constructor(){this.connections = new Set();this.gain={value:1};this.fftSize=1024;}
  connect(node){this.connections.add(node);return node;}
  disconnect(node){if(node)this.connections.delete(node);else this.connections.clear();}
}
const nodes=new Map();
class AudioContext {
  constructor(){this.state='running';this.destination = new FakeNode();}
  createAnalyser(){return new FakeNode();}
  createGain(){return new FakeNode();}
  createMediaElementSource(el){const node = new FakeNode();nodes.set(el,node);return node;}
  resume(){this.state='running';return Promise.resolve();}
}
const players=[];
class FakeAudio {
  constructor(){this.listeners={};this.duration=10;this.currentTime=0;this.paused=true;this.volume=1;this.src='';players.push(this);}
  addEventListener(name,fn){(this.listeners[name] ||= []).push(fn);}
  emit(name){for(const fn of this.listeners[name] || [])fn({target:this,type:name});}
  async play(){this.paused=false;this.emit('play');return true;}
  pause(){this.paused=true;this.emit('pause');}
  ended(){this.currentTime=this.duration;this.paused=true;this.emit('ended');}
}
const nativePauses=[], providerControllers=[], playbackEvents=[];
const win={
 EveAudioflixAudioWaveform:{},EveAudioflixAudioLayers:{},EveAudioflixProviderLayers:{},EveAudioflixState:{normalizeVolume:v=>typeof v==='number'?v:1},
 EveAudioflixUrlProviders:{providerFor:url=>/youtube\.com/.test(url)?'youtube':/spotify\.com/.test(url)?'spotify':/^https?:/.test(url)?'direct':''},
 EveAudioflixPlaybackPolicy:{policyOf:item=>item._effectivePlaybackPolicy||{outputKind:'browser',outputId:'',spotifyMethod:'embed'}},
 EveAudioflixUrlPlayback:{createController:options=>{const controller={stopped:false,paused:false,
   async play(item){controller.item=item;options.onProgress?.({currentTime:0,duration:9,paused:false});options.onPlayback?.({status:'Playing '+item.title});return true;},
   async pause(){controller.paused=true;},async resume(){controller.paused=false;},async destroy(){controller.stopped=true;},setVolume(){}};providerControllers.push(controller);return controller;}},
 EveAudioflixNative:{shouldSuppressBrowserPlayback:()=>false,setVoicesPaused:async paused=>{nativePauses.push(paused);return{ok:true};}},
 EveAudioflixAudioSource:{needsResolution:()=>false},
 EveAudioflixOutputPort:{effective:v=>v},
 AudioContext,
 setInterval:()=>123,clearInterval:()=>{}, addEventListener:()=>{},dispatchEvent:event=>{playbackEvents.push(event);},
 requestAnimationFrame:()=>2,cancelAnimationFrame:()=>{},devicePixelRatio:1
};
const context=vm.createContext({window:win, Audio:FakeAudio, console, WeakMap, WeakSet, Set, Map, Date, Number, Math, Promise, Uint8Array, setTimeout,
 CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}}});
vm.runInContext(waveformSource,context,{filename:'waveform.js'});
let main=new FakeAudio();
const wave=win.EveAudioflixAudioWaveform.createController(()=>main);
win.EveAudioflixAudio={getWaveformController:()=>wave};
vm.runInContext(providerLayerSource,context,{filename:'provider-layers.js'});
vm.runInContext(layerSource,context,{filename:'layers.js'});
let sharedCount=0;
const ctl=win.EveAudioflixAudioLayers.createController({
 state:()=>({preferredSinkId:''}),dispatch:()=>{}, shouldPreferUrl:()=>true,
 playUrlItem:async()=>{sharedCount++;return true;}, stopUrlPlayback:async()=>{},
 tryNativePlayback:async()=>false, getDecodedBuffer:async()=>{throw Error('unexpected native decode');},
 canPlayUrl:()=>true, canUseSharedUrlLayer:()=>true
});
(async()=>{
  const sound={id:'test-sound',type:'sound',url:'https://example.invalid/test.mp3',title:'Test',volume:0.5};
  assert.equal(await ctl.layerPlay(sound),true);
  assert.equal(await ctl.layerPlay(sound),true);
  assert.equal(sharedCount,0,'direct soundboard clips must not go to singleton URL playback');
  let voices=ctl.getSnapshot(sound.id);assert.equal(voices.length,2,'two active layer records');
  assert.notEqual(voices[0].id,voices[1].id,'separate layer identities');
  const layerPlayers=players.filter(p=>p.src===sound.url);
  assert.equal(layerPlayers.length,2,'two independent browser media players');
  assert.equal(await ctl.pauseAll(),true,'shared transport pauses active layers');
  assert(layerPlayers.every(player=>player.paused),'every browser layer pauses without losing its position');
  assert.equal(await ctl.resumeAll(),true,'shared transport resumes active layers');
  assert(layerPlayers.every(player=>!player.paused),'every browser layer resumes independently');
  assert.deepEqual(nativePauses,[true,false],'native voice lane follows the same pause/resume owner');
  assert.equal(nodes.get(layerPlayers[0])?.connections.size,1,'first source remains connected after second Layer Play');
  assert.equal(nodes.get(layerPlayers[1])?.connections.size,1,'second source is connected');
  // Singleton music may switch owners; independent soundboard voices must survive.
  const music1=new FakeAudio();wave.attachPlayer(music1);
  const music2=new FakeAudio();wave.attachPlayer(music2);
  assert.equal(nodes.get(music1).connections.size,0,'singleton music releases its prior source');
  assert.equal(nodes.get(layerPlayers[0]).connections.size,1,'singleton switch must not silence first layer');
  layerPlayers[0].ended();
  assert.equal(nodes.get(layerPlayers[0]).connections.size,0,'finished layer releases its graph route');
  assert.equal(nodes.get(layerPlayers[1]).connections.size,1,'finishing first does not silence second');
  assert.equal(ctl.getSnapshot(sound.id).length,1,'finished record removes only itself');
  await Promise.allSettled(ctl.stopItemLayers(sound.id));
  assert.equal(nodes.get(layerPlayers[1]).connections.size,0,'Stop releases remaining audio route');
  assert.equal(ctl.projectExternalLayer({itemId:sound.id,voiceId:`hk:${sound.id}`,title:sound.title,duration:1.61,startedAt:Date.now()}),true);
  voices=ctl.getSnapshot(sound.id);assert.equal(voices.length,1,'hotkey voice projects into the shared layer UI');
  assert.equal(voices[0].native,true);assert.equal(voices[0].duration,1.61);
  assert.equal(ctl.projectExternalLayer({itemId:sound.id,voiceId:`hk:${sound.id}`,title:sound.title,duration:1.61,startedAt:Date.now()}),true);
  assert.equal(ctl.getSnapshot(sound.id).length,1,'repeated hotkey replaces its prior projected voice');
  await Promise.allSettled(ctl.stopItemLayers(sound.id));
  const before=sharedCount;
  assert.equal(await ctl.layerPlay({id:'provider',type:'sound',url:'https://www.youtube.com/watch?v=abcdefghijk'}),true);
  assert.equal(await ctl.layerPlay({id:'provider',type:'sound',url:'https://www.youtube.com/watch?v=abcdefghijk'}),true);
  assert.equal(sharedCount,before,'YouTube layers use independent provider controllers instead of shared Music playback');
  assert.equal(providerControllers.length,2,'each provider Layer Play receives its own bounded controller');
  assert.equal(ctl.getSnapshot('provider').length,2,'independent provider voices are projected into the layer timeline');
  win.EveAudioflixAudioSource.needsResolution=()=>true;
  win.EveAudioflixAudioSource.resolveItem=async()=>{throw Error('resolver offline');};
  assert.equal(await ctl.layerPlay({id:'provider-resolver-offline',type:'sound',url:'https://www.youtube.com/watch?v=abcdefghijk'}),true);
  assert.equal(sharedCount,before,'resolver failure falls through to an independent provider instead of stealing Music');
  win.EveAudioflixAudioSource.needsResolution=()=>false;
  const protectedCtl=win.EveAudioflixAudioLayers.createController({state:()=>({}),dispatch:()=>{},shouldPreferUrl:()=>true,canPlayUrl:()=>true,canUseSharedUrlLayer:()=>false,playUrlItem:async()=>{sharedCount++;return true;}});
  assert.equal(await protectedCtl.layerPlay({id:'provider-independent',type:'sound',url:'https://www.youtube.com/watch?v=abcdefghijk'}),true);
  assert.equal(sharedCount,before,'independent YouTube Layer Play does not replace an active Music owner');
  assert.equal(await protectedCtl.layerPlay({id:'managed-blocked',type:'music',url:'https://open.spotify.com/track/1234567890123456789012',spotifyPlaybackMode:'managed-engine'}),false);
  assert.equal(sharedCount,before,'single-owner managed Spotify never impersonates independent layering');
  assert(playbackEvents.some(event=>event.detail?.layer&&event.detail?.error),'unsupported managed layering reports a visible capability error');
  await Promise.allSettled(ctl.stopItemLayers('provider'));
  assert(providerControllers.slice(0,2).every(controller=>controller.stopped),'Stop retires only the item\'s independent provider controllers');
  console.log('AUDIOFLIX_POLYPHONIC_BROWSER_LAYER_GRAPH_OK independent=2 provider=isolated managed=fail-closed stop=isolated');
})().catch(err=>{console.error(err);process.exitCode=1});
