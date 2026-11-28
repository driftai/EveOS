'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const src=fs.readFileSync(process.env.WF_FRAME_SOURCE || process.argv[2] || require('node:path').resolve(__dirname,'../../js/modules/features/watchfusion/watchfusion.frame-capabilities.js'),'utf8');
function lab(mode='lan') {
    let now=100000,seq=0,frame,probeCount=0;const timers=new Map(),events=new Map(),writes=[],pending=[];
    const element=()=>({dataset:{},hidden:false,textContent:'',setAttribute(){},addEventListener(){}});
    const detail=element(),retry=element(),surface=element(),head=element(),wrap=element();let note=null;
    surface.querySelector=s=>s==='[data-wf-frame-detail]'?detail:retry;
    wrap.querySelector=()=>surface;wrap.dataset.frameState='loading';
    head.querySelector=()=>note;head.prepend=n=>{note=n;};
    function makeFrame(url='http://127.0.0.1:9087/?eveos=1'){
        let value=url; const listeners={},attrs={};return {dataset:{},hidden:false,contentWindow:{},get src(){return value;},set src(v){value=v;writes.push(v);},closest:()=>wrap,matches:()=>true,getAttribute:k=>attrs[k],setAttribute:(k,v)=>attrs[k]=v,addEventListener:(k,v)=>listeners[k]=v,listeners};
    }
    frame=makeFrame();const document={querySelector:s=>s.includes('head-actions')?head:frame,createElement:element};
    const dispatch=(kind,data)=>{for(const fn of events.get(kind)||[])fn(data);};
    let modeProbe=()=>Promise.resolve({ok:true});
    const ctx={document,URL,Date:{now:()=>now},MutationObserver:class{observe(){}disconnect(){}},EveWatchFusion:{getState:()=>({exposureMode:mode})},EveWatchFusionRuntimeSensor:{probe:()=>{probeCount++;return modeProbe();},isCandidateOrigin:o=>o==='http://127.0.0.1:9087'},addEventListener:(k,fn)=>{if(!events.has(k))events.set(k,[]);events.get(k).push(fn);},setTimeout:(fn,ms)=>{timers.set(++seq,{fn,at:now+ms});return seq;},clearTimeout:id=>timers.delete(id)};ctx.window=ctx;
    vm.runInNewContext(src,ctx);
    const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
    const advance=async ms=>{const end=now+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at).find(x=>x[1].at<=end);if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}now=end;await flush();};
    const hb=(override={},source=frame.contentWindow,origin='http://127.0.0.1:9087')=>dispatch('message',{source,origin,data:{source:'WatchFusion',version:1,type:'watchfusion:embedded-presence',url:frame.src,time:now,...override}});
    return {ctx,wrap,writes,timers,advance,flush,hb,get frame(){return frame;},get probes(){return probeCount;},get note(){return note;},tick:()=>dispatch('eve:watchfusion-presence',{detail:{embedded:false}}),cached:()=>dispatch('eve:watchfusion-presence',{detail:{embedded:true}}),refresh:()=>dispatch('eve:watchfusion-status',{}),hold:()=>{modeProbe=()=>new Promise(r=>pending.push(r));},complete:()=>pending.shift()?.({ok:true}),reject:()=>{modeProbe=()=>Promise.reject(Error('offline'));},replace:()=>{const old=frame;frame=makeFrame();dispatch('eve:watchfusion-status',{});return old;}};
}
test('established frame survives repeated presence expiry, no reload or loading cover',async()=>{const x=lab();x.hb();assert.equal(x.wrap.dataset.frameState,'ready');for(let i=0;i<6;i++){await x.advance(15000);x.tick();x.refresh();assert.equal(x.wrap.dataset.frameState,'ready');assert.equal(x.wrap.dataset.frameConnectivity,'degraded');assert.equal(x.note.hidden,false);}assert.equal(x.writes.length,0);assert.equal(x.probes,0);x.hb();assert.equal(x.wrap.dataset.frameConnectivity,'healthy');assert.equal(x.note.hidden,true);});
test('heartbeat arriving while initial health probe is pending wins',async()=>{const x=lab();x.hold();await x.advance(10000);assert.equal(x.probes,1);x.hb();x.complete();await x.flush();assert.equal(x.wrap.dataset.frameState,'ready');assert.equal(x.writes.length,0);});
test('periodic status cannot postpone initial timeout or replenish retry',async()=>{const x=lab();for(let i=0;i<9;i++){await x.advance(3000);x.refresh();}assert.equal(x.probes,2);assert.equal(x.writes.length,1);assert.equal(x.wrap.dataset.frameState,'error');x.cached();x.refresh();await x.advance(60000);assert.equal(x.writes.length,1);assert.equal(x.probes,2);});
test('cloudflare retains its no-automatic-reload policy',async()=>{const x=lab('cloudflare');await x.advance(22000);assert.equal(x.probes,1);assert.equal(x.writes.length,0);assert.equal(x.wrap.dataset.frameState,'error');});
test('wrong window, wrong origin and stale cached presence cannot establish',async()=>{const x=lab();x.hb({},{});x.hb({},x.frame.contentWindow,'http://wrong:9087');x.hb({time:0});x.cached();assert.equal(x.wrap.dataset.frameState,'loading');x.hb();assert.equal(x.wrap.dataset.frameState,'ready');});
test('manual reload remains available, old navigation heartbeat cannot qualify new one',async()=>{const x=lab();x.hb();const prior=x.frame.src;assert.equal(x.ctx.EveWatchFusionFrameCapabilities.reload(true),true);assert.equal(x.writes.length,1);x.hb({url:prior});assert.equal(x.wrap.dataset.frameState,'loading');x.hb();assert.equal(x.wrap.dataset.frameState,'ready');assert.equal(x.ctx.EveWatchFusionFrameCapabilities.reload(false),false);});
test('stale probe after manual reload does not touch new scope',async()=>{const x=lab();x.hold();await x.advance(10000);x.ctx.EveWatchFusionFrameCapabilities.reload(true);const current=x.frame.src;x.complete();await x.flush();assert.equal(x.frame.src,current);assert.equal(x.writes.length,1);assert.equal(x.wrap.dataset.frameState,'loading');});
test('replaced frame does not inherit or accept old frame witness',async()=>{const x=lab();x.hb();const old=x.replace();x.hb({},old.contentWindow);assert.equal(x.wrap.dataset.frameState,'loading');old.listeners.load();x.hb();assert.equal(x.wrap.dataset.frameState,'ready');});
test('hidden lifecycle invalidates pending probe',async()=>{const x=lab();x.hold();await x.advance(10000);x.frame.hidden=true;x.refresh();x.complete();await x.flush();assert.equal(x.writes.length,0);});
test('unavailable initial health probe does not reload and retains manual retry',async()=>{const x=lab();x.reject();await x.advance(10000);assert.equal(x.wrap.dataset.frameState,'error');assert.equal(x.writes.length,0);assert.equal(x.ctx.EveWatchFusionFrameCapabilities.reload(true),true);});
test('late iframe load event after readiness cannot schedule a destructive timer',async()=>{const x=lab();x.hb();x.frame.listeners.load();await x.advance(60000);x.tick();assert.equal(x.probes,0);assert.equal(x.writes.length,0);assert.equal(x.wrap.dataset.frameState,'ready');});

test('established accessor cannot survive navigation or hidden frame',async()=>{const x=lab();x.hb();assert.equal(x.ctx.EveWatchFusionFrameCapabilities.established(),true);x.ctx.EveWatchFusionFrameCapabilities.reload(true);assert.equal(x.ctx.EveWatchFusionFrameCapabilities.established(),false);x.hb();x.frame.hidden=true;assert.equal(x.ctx.EveWatchFusionFrameCapabilities.established(),false);});
