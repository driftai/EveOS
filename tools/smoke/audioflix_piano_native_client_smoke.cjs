'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('EveOS.html');
assert(html.includes('audioflix.piano.native.js?v='));
assert(html.indexOf('audioflix.piano.native.js?v=') < html.indexOf('audioflix.piano.ui.js?v='));
const store = new Map(), logs = [];
const context = { console, Map, Promise, Uint8Array, crypto: require('node:crypto').webcrypto,
  localStorage: { getItem:k=>store.get(k)||null, setItem:(k,v)=>store.set(k,v), removeItem:k=>store.delete(k) },
  window: { EveAudioflixNativeProviderCapture: { pianoNative:async (action,payload)=>{
    logs.push({action,payload});
    if(action==='start') return { ok:true,sessionId:'session1',sessionToken:'secret',ownerId:payload.ownerId,
      generation:payload.generation,deviceId:'sd:7',soundId:payload.soundId };
    if(action==='status') return { state:'playing' };
    return {ok:true,state:'playing'};
  } }, EveAudioflixPianoPcm: { revoke:async()=>true } }
};
vm.runInNewContext(read('js/modules/features/audioflix/audioflix.piano.native.js'),context);
(async()=>{
  const c=context.window.EveAudioflixPianoNative;
  await c.start({timeline:{events:[{at_ms:0,midi_notes:[60]}]},soundId:'acoustic_grand',volumePercent:0});
  await c.pause({paused:false}); await c.seek({seconds:2.5}); await c.volume({volume:0});
  assert.equal(logs[0].action,'start'); assert.equal(logs[0].payload.volumePercent,0);
  assert.equal(logs[1].payload.paused,false);
  assert.equal(logs[2].payload.seconds,2.5);
  assert.equal(logs[3].payload.volume,0);
  const script=read('tools/Piano-Auto-Player/web/internal_preview_native.js');
  assert(script.includes("this.request('start'"));
  assert(script.includes('this.active = false'));
  assert(script.includes('piano-engine-dialog'));
  assert(script.includes('data-engine-selected'));
  assert(script.includes('AudioFlix-selected output'));
  console.log('AUDIOFLIX_PIANO_NATIVE_CLIENT_OK endpoint=sd:7 browserFallback=explicit');
})().catch(e=>{ console.error(e);process.exitCode=1; });

// Exercise the *real* child-side adapter and the new engine picker DOM, with a
// documented minimal DOM surface instead of a legacy checkbox-only mock.
const adapter = read('tools/Piano-Auto-Player/web/internal_preview_native.js')
  .replace(/^import .*piano_sound\.js.*\n/m, 'const pianoMasterVolume = () => 68;\n')
  .replace('export class ServerOwnedPreview', 'class ServerOwnedPreview');
const messages = [], listeners = {}, nodes = [];
function element(tag) {
  const handlers = {};
  const el = {
    tagName:tag, handlers, dataset:{}, style:{}, children:[], attributes:{},
    checked:false, disabled:false, hidden:false, textContent:'', id:'', className:'',
    append(...children) { this.children.push(...children); },
    before(...children) { this.beforeNodes = [...(this.beforeNodes||[]),...children]; },
    addEventListener(type,callback) { (handlers[type]??=[]).push(callback); },
    dispatchEvent(event) { for(const callback of handlers[event.type]||[]) callback(event); return true; },
    setAttribute(name,value) { this.attributes[name]=String(value); },
    getAttribute(name) { return this.attributes[name] || null; },
    showModal() { this.open=true; },
    querySelectorAll(selector) {
      return this.tagName==='dialog' && selector==='input[type="radio"]' ? this.radios : [];
    },
    querySelector(selector) {
      if(this.tagName!=='dialog') return null;
      if(selector==='[data-engine-selected]') return this.selected;
      if(selector==='[data-engine-note]') return this.note;
      return null;
    }
  };
  if(tag==='dialog') {
    el.radios=[{value:'server',checked:false,disabled:false},{value:'browser',checked:false,disabled:false}];
    el.selected={textContent:''}; el.note={textContent:''};
  }
  nodes.push(el); return el;
}
const label=element('label');
const internal=element('input');internal.id='internalPlay'; internal.parentElement=label;
const doc = {
  hidden:false, body:element('body'), head:element('head'),
  getElementById(id) { return nodes.find(node=>node.id===id)||null; },
  querySelector(selector) {
    if(selector==='.piano-engine-dialog') return nodes.find(node=>node.className==='piano-engine-dialog')||null;
    if(selector==='[data-piano-engine-open]') return nodes.find(node=>Object.hasOwn(node.dataset,'pianoEngineOpen'))||null;
    return null;
  },
  createElement:element
};
class EventMock { constructor(type, options) { this.type=type;this.bubbles=Boolean(options?.bubbles); } }
const hostContext = { pianoNative:{available:true,preferred:true}, outputRoute:'CABLE Input (sd:7)' };
const uiWindow = { addEventListener(type,callback) { listeners[type]=callback; },
  PianoEveOS: { getContext:()=>hostContext, native:async (action,payload)=>{
    messages.push({action,payload});
    if(action==='attach') return null;
    return {state:action==='pause' ? (payload.paused?'paused':'playing'):'playing',
      currentTime:0,duration:2,message:'Native',totalEvents:2};
  } }
};
const uiContext = { console, Promise, Number, Array, String, Math, Map,
  setTimeout:()=>0, Event:EventMock, document:doc, window:uiWindow };
vm.runInNewContext(adapter+'\nthis.ServerOwnedPreview=ServerOwnedPreview;',uiContext);
(async()=>{
  const preview={rows:[],output:{sound:{soundId:'acoustic_grand'}}};
  const server=new uiContext.ServerOwnedPreview(preview);
  assert(server.control, 'engine checkbox created');
  assert(server.enginePicker, 'new modal created');
  assert(server.engineTrigger, 'settings gear created');
  assert.equal(server.control.hidden,true);
  assert.equal(server.control.checked,true,'native selected from authenticated host');
  assert.equal(internal.checked,true,'Internal Play enabled');
  assert.match(server.enginePicker.selected.textContent,/CABLE Input \(sd:7\)/);
  assert.equal(server.enginePicker.radios[0].checked,true);
  server.engineTrigger.dispatchEvent({type:'click',preventDefault(){}});
  assert.equal(server.enginePicker.open,true,'engine gear opens dialog');
  server.enginePicker.dispatchEvent({type:'change',target:{value:'browser'}});
  assert.equal(server.control.checked,false,'browser can be selected when stopped');
  server.enginePicker.dispatchEvent({type:'change',target:{value:'server'}});
  assert.equal(server.control.checked,true,'server mode can be restored');
  assert(server.start({duration_ms:2000,events:[{at_ms:0,midi_notes:[60]},{at_ms:1000,midi_notes:[64]}]},1));
  await new Promise(resolve=>setImmediate(resolve));
  const started=messages.find(x=>x.action==='start');
  assert.equal(started.payload.volumePercent,68);
  assert.equal(started.payload.timeline.events.length,2);
  assert.equal(started.payload.soundId,'acoustic_grand');
  assert.equal(server.enginePicker.radios[1].disabled,true,'browser switching locked during native playback');
  server.enginePicker.dispatchEvent({type:'change',target:{value:'browser'}});
  assert.equal(server.control.checked,true,'native playback not hijacked by browser mode');
  server.togglePause(); await new Promise(resolve=>setImmediate(resolve));
  assert(messages.some(x=>x.action==='pause'&&x.payload.paused===true));
  server.seek(2); await new Promise(resolve=>setImmediate(resolve));
  assert(messages.some(x=>x.action==='seek'&&x.payload.seconds===1));
  server.stop();
  await new Promise(resolve=>setImmediate(resolve));
  assert(messages.some(x=>x.action==='stop'));
  // Reinstallation/re-initialization must reuse the existing control safely.
  server.installControl();
  assert.equal(server.control.id,'serverOwnedPiano');
  assert.equal(server.enginePicker,doc.querySelector('.piano-engine-dialog'));
  console.log('AUDIOFLIX_PIANO_SERVER_UI_OK owner=server route=AudioFlix modal=verified');
})().catch(e=>{console.error(e);process.exitCode=1;});
