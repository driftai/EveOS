'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../../js/modules/features/audioflix/audioflix.spotify.direct.js'), 'utf8');
const ERR = 'Windows Electron output failed closed: Spotify Widevine audio license failed (HTTP 500).';
const identity = {spotifyUri:'spotify:track:4cOdK2wGLETKBW3PvgPWqT',mediaType:'track',spotifyId:'4cOdK2wGLETKBW3PvgPWqT'};

function setup(method) {
  const events=[];
  const audio={ ready:true, playItem: async () => true, layerPlay: async () => true,
    openInternalView: async () => true, pause:async()=>true, resume:async()=>true,
    seek:async()=>true, stopAll:async()=>true, stopItemLayers:async()=>true,
    updateItemVolume(){}, getPlaybackState:()=>({}), getStatus:()=>({}) };
  const window={
    EveAudioflixAudio:audio,
    EveAudioflixSpotifyMedia:{ready:true,fromItem:(v)=>v&&v.spotify?identity:null},
    EveAudioflixNative:{ready:true,request:async (url,opts)=> {
      if(url.endsWith('/command') && opts.body.includes('"action":"play"')) return {ok:false,reason:ERR};
      return {ok:true,state:{status:'stopped'}};
    }},
    EveAudioflixPlaybackPolicy:{resolve:()=>({spotifyMethod:'electron', outputKind:'native', outputId:'sd:7',sourcePreference:'original'})},
    EveAudioflix:{queueConnection:{snapshot:()=>({playbackRunId:1})}},
    dispatchEvent:(v)=>events.push(v.detail),
    addEventListener:()=>{},
  };
  const ctx={window, CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail}},
    setInterval:()=>1,clearInterval:()=>{}};
  vm.runInNewContext(SOURCE,ctx);
  const item={spotify:true,id:'song-1',title:'Test Spotify track',duration:181,volume:1};
  return {audio,item,events};
}

test('card Play rejects DRM cleanly without leaving an unhandled promise rejection',async()=>{
  const {audio,item,events}=setup();
  assert.equal(await audio.playItem(item),false);
  const failures=events.filter(e=>e.electronDirect && e.terminal && e.error);
  assert.equal(failures.length,1);
  assert.match(failures[0].status,/Widevine.*500/);
  assert.equal(await audio.layerPlay(item),false);
  assert.equal(await audio.openInternalView(item),false);
});

test('unrelated playback retains its original behavior',async()=>{
  const {audio,item}=setup();
  const other={id:'local-file'};
  assert.equal(await audio.playItem(other),true);
  assert.equal(await audio.layerPlay(other),true);
});
