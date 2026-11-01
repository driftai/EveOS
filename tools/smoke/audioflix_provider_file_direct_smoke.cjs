'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const code = fs.readFileSync(path.join(root, 'js/modules/features/audioflix/audioflix.native.provider-capture.js'), 'utf8');
async function exercise(isFile) {
  const calls = [];
  const location = isFile
    ? {protocol:'file:',hostname:'',origin:'null',href:'file:///C:/EveOS/EveOS.html'}
    : {protocol:'http:',hostname:'127.0.0.1',origin:'http://127.0.0.1:8765',href:'http://127.0.0.1:8765/EveOS.html'};
  const ui = { appendChild(script) {
      assert(isFile, 'localhost must not load private file credential');
      assert(script.src.includes('data/runtime/audioflix-provider-file-auth.js'));
      window.__EveOSProviderFileAuth='f'.repeat(64);
      process.nextTick(()=>script.onload());
    }};
  const document = {createElement:()=>({remove(){} }), head:ui};
  const window = {
    location, EveAudioflixNativeProviderCapture: {}, EveAudioflixNativeIdentity: {
      isEveOsBridge: async base=>base==='http://127.0.0.1:8765'
    },
    EveAudioflixState: {ensure:()=>({nativeBridgeEnabled:true,nativeOutputId:'sd:7',nativeOutputLabel:'CABLE'})}
  };
  const fetch = async (url,options) => {
    calls.push({url,options});
    assert(url.startsWith('http://127.0.0.1:8765/api/audioflix/provider-capture/'));
    return {ok:true,status:200,json:async()=>url.endsWith('/start')
      ? {ok:true,sessionId:'provider:test',captureToken:'protected-server-session',deviceId:'sd:7'}
      : {ok:true,deviceId:'sd:7',rendererRunning:true}};
  };
  const ctx = {window,document,fetch,AbortController,URL,Date,setTimeout,clearTimeout,console};
  vm.createContext(ctx);vm.runInContext(code,ctx);
  const api=window.EveAudioflixNativeProviderCapture;
  const started=await api.start({source:'provider-tab'});
  assert.equal(started.deviceId,'sd:7');
  await api.send(started,'AAAA',{gain:.5});
  await api.status(started);
  await api.stop(started);
  assert.equal(calls.length,4);
  assert(calls.every(({options}) => options.mode === (isFile?'cors':'same-origin')));
  assert(calls.every(({options}) => options.headers['X-EveOS-Provider-Capture']==='v1'));
  if(isFile){
    assert.equal(calls[0].options.headers['X-EveOS-Provider-File-Auth'], 'f'.repeat(64));
    assert(!calls.slice(1).some(c=>c.options.headers['X-EveOS-Provider-File-Auth']));
    assert.equal(window.__EveOSProviderFileAuth,undefined,'script global must be removed');
    assert(!('prepareFileCompanion' in api),'no popup helper');
  } else assert(!calls.some(x=>x.options.headers['X-EveOS-Provider-File-Auth']));
}
(async()=>{await exercise(false);await exercise(true);console.log('AUDIOFLIX_PROVIDER_FILE_DIRECT_OK file_capture=true localhost_capture=true credential_start_only=true no_popup=true');})().catch(e=>{console.error(e);process.exitCode=1});
