'use strict';
// No browser, network, Spotify entitlement, or physical audio required.
// Executes the actual repository inline iframe host with a deterministic SDK.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = process.argv[2] || process.cwd();
const htmlPath = path.join(root, 'server/spotify-embed-edge.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<script>\s*([\s\S]*?)<\/script>/i);
assert(match, 'Spotify iframe host inline script missing');
const SCRIPT = match[1];
const A = 'spotify:track:' + 'A'.repeat(22);
const B = 'spotify:track:' + 'B'.repeat(22);
const C = 'spotify:track:' + 'C'.repeat(22);

function host(initial = A) {
  const events = [], operations = [], listeners = {}, timers = [], intervals = [];
  const controls = [];
  const message = { textContent: '' };
  const document = {
    title: '', head: {appendChild(){}},
    getElementById(id) { return id === 'message' ? message : { id, appendChild() {} }; },
    createElement() { return { src:'', async:false, onerror:null }; }
  };
  let now = 0;
  const controller = {
    addListener(kind, cb) { listeners[kind] = cb; },
    loadEntity(uri) { operations.push(['loadEntity', uri]); },
    restart() { operations.push(['restart']); },
    pause() { operations.push(['pause']); },
    resume() { operations.push(['resume']); },
    seek(v) { operations.push(['seek', v]); }
  };
  const fetch = async (url, config = {}) => {
    if (url.endsWith('/controls')) {
      return { ok: true, json: async () => ({ ok: true, commands: controls.shift() || [] }) };
    }
    if (url.endsWith('/event')) {
      const payload = JSON.parse(config.body);
      events.push(payload);
      return { ok: true, json: async () => ({ ok:true }) };
    }
    throw new Error('Unexpected network: ' + url);
  };
  const ctx = {
    window: {}, document, fetch,
    location: {search:'?uri='+encodeURIComponent(initial)+'&session='+ 'S'.repeat(40) + '&windowId='+'W'.repeat(22)},
    performance: {now:()=>now}, URLSearchParams,
    setInterval(fn){ intervals.push(fn); return intervals.length; },
    setTimeout(fn,delay){timers.push({fn,delay}); return timers.length;},
    console
  };
  vm.runInNewContext(SCRIPT, ctx, { filename: htmlPath, timeout: 1500 });
  assert.equal(typeof ctx.window.onSpotifyIframeApiReady, 'function');
  ctx.window.onSpotifyIframeApiReady({ createController(_el, opts, cb) {
    assert.equal(opts.uri, initial);
    cb(controller);
  }});
  const settle = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
  async function load(uri, revision) {
    controls.push([{action:'load',uri,revision}]);
    assert.equal(intervals.length,1);
    await intervals[0]();
    await settle();
  }
  async function update(uri, {position=0,duration=190000,isPaused=true,isBuffering=false} = {}) {
    now += 1000;
    assert(listeners.playback_update);
    listeners.playback_update({data:{playingURI:uri,position,duration,isPaused,isBuffering}});
    await settle();
  }
  const mediaEvents = () => events.filter(x=>x.kind==='media-loaded');
  return {events,operations,timers,listeners,message,load,update,mediaEvents,settle};
}

async function run() {
  {
    const h=host();
    await h.load(B,1);
    assert.deepEqual(h.operations[0], ['loadEntity', B]);
    assert.equal(h.mediaEvents().length,0,'loadEntity return must not acknowledge new media');
    await h.update(A, {position:16000});
    assert.equal(h.mediaEvents().length,0,'old song callback cannot acknowledge new URI');
    await h.update(B, {position:0,isBuffering:true});
    assert.equal(h.mediaEvents().length,0,'buffering cannot acknowledge');
    await h.update(B, {position:0,isPaused:true,isBuffering:false});
    assert.equal(h.mediaEvents().length,1,'new song state acknowledges exactly once');
    assert.equal(h.mediaEvents()[0].revision,1);
    assert.equal(h.mediaEvents()[0].playingURI,B);
    await h.update(B, {position:1200});
    assert.equal(h.mediaEvents().length,1,'repeated callbacks do not repeat UIA invitation');
    console.log('PASS new URI loading requires matching nonbuffering playback state');
  }
  {
    const h=host();
    await h.load(B,1);
    await h.load(C,2);
    await h.update(B, {position:0});
    assert.equal(h.mediaEvents().length,0,'stale revision cannot load');
    await h.update(C, {position:0});
    assert.equal(h.mediaEvents().length,1);
    assert.equal(h.mediaEvents()[0].revision,2);
    assert.equal(h.mediaEvents()[0].playingURI,C);
    console.log('PASS superseded revision cannot arm wrong-track Play');
  }
  {
    const h=host();
    await h.load(A,1);
    assert.deepEqual(h.operations[0],['restart']);
    await h.update(A,{position:42000});
    assert.equal(h.mediaEvents().length,0,'old same-URI position is not restart confirmation');
    await h.update(A,{position:0});
    assert.equal(h.mediaEvents().length,1);
    console.log('PASS same-URI repeated slot must restart near beginning');
  }
  {
    // V3: loadEntity can paint the card without an immediate playback_update.
    // After a bounded render-settle interval the existing backend UIA helper
    // receives exactly one revision-owned media-loaded invitation. This is
    // NOT proof that audio started; the backend still checks routed progress.
    const h=host();
    await h.load(B,1);
    assert.equal(h.mediaEvents().length,0,'loadEntity alone cannot arm Play');
    const timer=h.timers.find(t=>t.delay===2200);
    assert(timer,'v3 requires a bounded render-settle fallback');
    timer.fn();
    await h.settle();
    assert.equal(h.mediaEvents().length,1,'fallback arms just one existing-window Play');
    assert.equal(h.mediaEvents()[0].revision,1);
    assert.equal(h.mediaEvents()[0].playingURI,B);
    timer.fn();
    await h.settle();
    assert.equal(h.mediaEvents().length,1,'timer cannot arm duplicate Play');
    assert.equal(h.events.filter(e=>e.kind==='play-failed').length,0,'fallback is not a load failure');
    assert.equal(h.events.filter(e=>e.kind==='ended').length,0,'Play invitation is never queue completion');
    console.log('PASS missing SDK readiness: bounded one-time Play invitation, not playback proof');
  }
  {
    const h=host();
    await h.load(B,1);
    const oldTimer=h.timers.find(t=>t.delay===2200);
    assert(oldTimer);
    await h.load(C,2);
    oldTimer.fn();
    await h.settle();
    assert.equal(h.mediaEvents().length,0,'superseded timer must not arm previous track');
    const newTimer=h.timers.filter(t=>t.delay===2200).at(-1);
    newTimer.fn();
    await h.settle();
    assert.equal(h.mediaEvents().length,1);
    assert.equal(h.mediaEvents()[0].revision,2);
    assert.equal(h.mediaEvents()[0].playingURI,C);
    console.log('PASS fallback refuses superseded track and URI');
  }
  {
    const h=host();
    await h.load(B,1);
    const timer=h.timers.find(t=>t.delay===2200);
    await h.update(B,{position:0,isPaused:true,isBuffering:false});
    assert.equal(h.mediaEvents().length,1);
    timer.fn();
    await h.settle();
    assert.equal(h.mediaEvents().length,1,'matching SDK readiness wins without duplicate UIA');
    console.log('PASS SDK readiness suppresses v3 fallback');
  }
  console.log('EDGE_SWITCH_V2_VM_SMOKE_PASS');
}
run().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
