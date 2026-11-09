'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(process.argv[2], 'utf8');
assert.match(source,/async function releaseIdleManagedEngineBeforeEmbed\(/);
assert.match(source,/if \(!reuse\)\s*\{\s*await releaseIdleManagedEngineBeforeEmbed\(\);\s*if \(current !== epoch\) return false;/);
assert.match(source,/request\(reuse \? 'switch' : 'play'/);
assert.match(source,/const pausedDirectRoute = capture\.active === true && capture\.outputMode === 'direct'/);
assert.doesNotMatch(source,/\|\| capture\.active === true \|\| transport\.paused === false/);
const start=source.indexOf('  async function releaseIdleManagedEngineBeforeEmbed() {');
const end=source.indexOf('  // White is an approved monochrome Spotify mark',start);
assert(start>=0 && end>start);
const helper=source.slice(start,end);
async function scenario(name,before,stop,after,expect){
  const calls=[];
  const statuses=[before,after];
  const bridge={request:async(url,opts)=>{
    calls.push(url.split('/').pop());
    if(url.endsWith('/status')) return statuses.shift();
    if(url.endsWith('/stop')) return stop;
    throw Error('Unexpected URL: '+url);
  }};
  const fn=vm.runInNewContext(`(function(bridge){const native=()=>bridge;${helper};return releaseIdleManagedEngineBeforeEmbed})`,{Error,Number,String})(bridge);
  let error='';
  try{await fn()}catch(e){error=String(e.message)}
  assert.equal(Boolean(error), Boolean(expect.error), name+': '+error);
  if(expect.error) assert.match(error,expect.error,name);
  assert.deepEqual(calls,expect.calls,name);
}
(async()=>{
  const paused={ok:true,browserRunning:true,helperReachable:true,playingCount:0,importing:false,
    state:'provider-paused',transport:{status:'provider-paused',paused:true},
    providerCapture:{active:true,outputMode:'direct',source:'managed-spotify',endpoint:'sd:7',state:'cable-routed',routeConfirmed:true}};
  const stopped={ok:true,browserRunning:false,helperReachable:false};
  const idle={...paused,state:'idle',transport:{status:'idle',paused:true},providerCapture:{active:false}};
  await scenario('paused native direct route may be retired',paused,{ok:true},stopped,{calls:['status','stop','status']});
  await scenario('inactive direct route',idle,{ok:true},stopped,{calls:['status','stop','status']});
  await scenario('Engine already stopped',stopped,null,null,{calls:['status']});
  await scenario('true tab capture must block',{...paused,providerCapture:{active:true,outputMode:'capture',source:'managed-spotify',endpoint:'sd:7'}},null,null,{calls:['status'],error:/active work/});
  await scenario('unknown active mode must block',{...paused,providerCapture:{active:true,source:'managed-spotify',endpoint:'sd:7'}},null,null,{calls:['status'],error:/active work/});
  await scenario('unknown source must block',{...paused,providerCapture:{active:true,outputMode:'direct',endpoint:'sd:7'}},null,null,{calls:['status'],error:/active work/});
  await scenario('invalid endpoint must block',{...paused,providerCapture:{active:true,outputMode:'direct',source:'managed-spotify',endpoint:'Speakers'}},null,null,{calls:['status'],error:/active work/});
  await scenario('playing media must block',{...paused,playingCount:1},null,null,{calls:['status'],error:/active work/});
  await scenario('playing transport must block',{...paused,transport:{status:'playing',paused:false}},null,null,{calls:['status'],error:/active work/});
  await scenario('starting transport must block',{...paused,state:'starting',transport:{status:'starting',paused:true}},null,null,{calls:['status'],error:/active work/});
  await scenario('importing must block',{...paused,importing:true},null,null,{calls:['status'],error:/active work/});
  await scenario('shutdown refused must block',paused,{ok:false,reason:'Engine is busy'},null,{calls:['status','stop'],error:/Engine is busy/});
  await scenario('shutdown unconfirmed must block',paused,{ok:true},paused,{calls:['status','stop','status'],error:/not confirmed/});
  await scenario('status read failure must block',{ok:false,reason:'403 forbidden'},null,null,{calls:['status'],error:/403 forbidden/});
  console.log('SPOTIFY_MODE_HANDOFF_V1_5_SMOKE_PASS 14');
})().catch(error=>{console.error(error);process.exitCode=1});
