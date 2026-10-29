'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const repo = process.argv[2] || path.resolve(__dirname, '..', '..');
const waveformSource = fs.readFileSync(path.join(repo,'js/modules/features/audioflix/audioflix.audio.waveform.js'),'utf8');
const layerSource = fs.readFileSync(path.join(repo,'js/modules/features/audioflix/audioflix.audio.layers.js'),'utf8');
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
const win={
 EveAudioflixAudioWaveform:{},EveAudioflixAudioLayers:{},EveAudioflixState:{normalizeVolume:v=>typeof v==='number'?v:1},
 EveAudioflixUrlProviders:{providerFor:url=>/youtube\.com/.test(url)?'youtube':/^https?:/.test(url)?'direct':''},
 EveAudioflixNative:{shouldSuppressBrowserPlayback:()=>false},
 EveAudioflixAudioSource:{needsResolution:()=>false},
 EveAudioflixOutputPort:{effective:v=>v},
 AudioContext,
 setInterval:()=>123,clearInterval:()=>{}, addEventListener:()=>{},dispatchEvent:()=>{},
 requestAnimationFrame:()=>2,cancelAnimationFrame:()=>{},devicePixelRatio:1
};
const context=vm.createContext({window:win, Audio:FakeAudio, console, WeakMap, WeakSet, Set, Map, Date, Number, Math, Promise, Uint8Array, setTimeout});
vm.runInContext(waveformSource,context,{filename:'waveform.js'});
let main=new FakeAudio();
const wave=win.EveAudioflixAudioWaveform.createController(()=>main);
win.EveAudioflixAudio={getWaveformController:()=>wave};
vm.runInContext(layerSource,context,{filename:'layers.js'});
let sharedCount=0;
const ctl=win.EveAudioflixAudioLayers.createController({
 state:()=>({preferredSinkId:''}),dispatch:()=>{}, shouldPreferUrl:()=>true,
 playUrlItem:async()=>{sharedCount++;return true;}, stopUrlPlayback:async()=>{},
 tryNativePlayback:async()=>false, getDecodedBuffer:async()=>{throw Error('unexpected native decode');},
 canPlayUrl:()=>true
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
  const before=sharedCount;
  assert.equal(await ctl.layerPlay({id:'provider',type:'sound',url:'https://www.youtube.com/watch?v=abcdefghijk'}),true);
  assert.equal(sharedCount,before+1,'provider iframe route retained for unsupported native media');
  console.log('AUDIOFLIX_POLYPHONIC_BROWSER_LAYER_GRAPH_OK independent=2 normalOwner=preserved stop=isolated provider=retained');
})().catch(err=>{console.error(err);process.exitCode=1});
