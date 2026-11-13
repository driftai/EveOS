'use strict';
// Isolated mock of the actual v3 iframe fallback block. The production HTML is
// supplied by caller. No Spotify requests, browser process, or local app is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf("const pending = awaitingMediaIdentity;", src.indexOf('Spotify is settling the new track'));
const end = src.indexOf('\n          } catch {', start);
assert.ok(start > 0 && end > start);
const snippet = src.slice(start, end);
assert.match(snippet, /2200/);
assert.match(snippet, /requested !== selectedUri/);
function scenario(name, tweak, expected) {
  const uri='spotify:track:'+'B'.repeat(22);
  const pending={revision:1,uri};
  const callbacks=[]; const acks=[];
  const ctx={
    awaitingMediaIdentity:pending,atRevision:1,revision:1,requested:uri,selectedUri:uri,
    message:{textContent:''}, setTimeout:(fn,delay)=>{callbacks.push({fn,delay});},
    acknowledgeLoadedMedia:(value)=>{acks.push(value);return Promise.resolve(true)}
  };
  vm.runInNewContext(`(() => { ${snippet} })()`,ctx);
  assert.equal(callbacks.length,1,`${name} one timer`);
  assert.equal(callbacks[0].delay,2200,`${name} settle delay`);
  tweak(ctx);
  callbacks[0].fn();
  callbacks[0].fn();
  assert.equal(acks.length,expected,`${name} acknowledgment count`);
  if(expected===1) {assert.equal(acks[0],pending); assert.equal(ctx.awaitingMediaIdentity,null);}
  process.stdout.write(`PASS ${name}\n`);
}
scenario('same media revision receives one Play arm',()=>{},1);
scenario('superseded revision receives zero Play arms',ctx=>ctx.revision=2,0);
scenario('superseded URI receives zero Play arms',ctx=>ctx.selectedUri='spotify:track:'+'C'.repeat(22),0);
scenario('SDK readiness first suppresses fallback',ctx=>ctx.awaitingMediaIdentity=null,0);
scenario('manual teardown suppresses fallback',ctx=>ctx.awaitingMediaIdentity={revision:5,uri:ctx.requested},0);
assert.ok(src.includes('completedRevision === revision'));
assert.ok(src.includes('void acknowledgeLoadedMedia(awaiting)'));
assert.ok(src.includes('info.isBuffering !== true'));
assert.ok(!snippet.includes("send('play-failed'"));
console.log('SPOTIFY_EDGE_V3_VM_FALLBACK_SMOKE_PASS');
