'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname,'../..');
const {create} = require('../../server_modules/audioflix_spotify_engine_output_host.js');
let checks=0;function test(x,name){assert.ok(x,name);checks++;}
(async()=>{
    let active=false, endpoint='',stops=0,starts=0,captureStops=0,captureStarts=0,modeSaves=0;
    const route = {
        status:()=>({active,endpoint,state:active?'route-pending':'idle',routeConfirmed:false}),
        async start(d){active=true;endpoint=d.deviceId;starts++;return this.status()},
        async stop(){active=false;stops++;return this.status()}
    };
    const controller={
        async status(){return {active:captureStarts>captureStops,source:'managed-spotify',endpoint:'sd:7'}},
        async start(x){captureStarts++;return {ok:true,capture:{active:true,source:'managed-spotify',endpoint:x.deviceId}}},
        async stop(){captureStops++;return {active:false}}
    };
    const bindings={};const frame={};const saved=[];
    const page={
        mainFrame(){return frame},url(){return 'http://127.0.0.1:8765/tools/audioflix/spotify-engine.html'},
        async evaluate(fn,arg){if(typeof arg==='string')return 'direct';if(arg?.key){saved.push(arg.mode);modeSaves++;return;}return null;},
        async exposeBinding(name,cb){bindings[name]=cb}
    };
    const host=await create({page,profileDir:'test',betaExecutable:'beta',sessionId:'test-session',
        captureController:controller,note(){},directFactory:()=>route});
    const source={frame,page};
    test(host.activeMode()==='direct','default direct');
    let x=await host.start({sessionId:'test-session',deviceId:'sd:7'});
    test(x.ok&&x.capture.active&&x.capture.endpoint==='sd:7','direct arm');
    test(starts===1&&captureStarts===0,'direct never invokes capture');
    x=await bindings.__eveSpotifyEngineSetOutputMode(source,'capture');
    test(x.ok&&host.activeMode()==='capture','mode changes to capture');
    test(stops===1&&!active,'direct released before capture');
    x=await host.start({sessionId:'test-session',deviceId:'sd:7'});
    test(x.ok&&captureStarts===1,'capture selected requires existing provider lane');
    x=await bindings.__eveSpotifyEngineSetOutputMode(source,'direct');
    test(x.ok&&host.activeMode()==='direct','switch back to direct');
    test(captureStops>=1&&starts===2,'capture stopped before direct starts');
    x=await bindings.__eveSpotifyEngineGetOutputStatus(source);
    test(x.ok&&x.mode==='direct'&&x.route.active,'status after route switch');
    test(modeSaves===2&&saved.join(',')==='capture,direct','mode persisted after successful switch');
    try{await bindings.__eveSpotifyEngineSetOutputMode({frame:{},page},'capture');assert.fail('allowed iframe')}catch(e){test(/trusted Engine/.test(e.message),'iframe cannot change routing')}
    x=await host.start({sessionId:'bad',deviceId:'sd:7'});
    test(x.ok===false&&x.sessionMatch===false,'session mismatch refused');
    await host.shutdown();
    test(!active,'shutdown restores direct route');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{
    if(!process.exitCode){
        const html=fs.readFileSync(path.join(ROOT,'tools/audioflix/spotify-engine.html'),'utf8');
        const owner=fs.readFileSync(path.join(ROOT,'server_modules/audioflix_spotify_browser.js'),'utf8');
        assert(html.includes('audioflix.spotify.engine-output.js'),'engine picker included');checks++;
        assert(owner.includes('await outputHost.start(body)'),'helper routes through output owner');checks++;
        assert(owner.includes('await outputHost.stop(body)'),'helper stop uses owner');checks++;
        console.log(`SPOTIFY_ENGINE_DUAL_MODE_SMOKE_PASS ${checks}`);
    }
});
