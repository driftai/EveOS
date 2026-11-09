'use strict';
// Runs the actual installed managedEngineInternalView function, with safe fake owners.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const path = process.argv[2];
if (!path) throw new Error('Supply actual Engine surface module path.');
const source = fs.readFileSync(path, 'utf8');
const begin = '        audio.openInternalView = async function managedEngineInternalView(item) {';
const end = '\n        };';
const start = source.indexOf(begin);
if (start < 0 || source.indexOf(begin, start + 1) >= 0) throw new Error('Expected exactly one Engine Internal View handler');
const stop = source.indexOf(end, start);
if (stop < 0) throw new Error('Engine Internal View handler end missing');
const snippet = source.slice(start, stop + end.length).trim();
const functionSource = snippet.replace(/^audio\.openInternalView\s*=\s*/, '').replace(/;$/, '');
if (/const result = await originalOpenInternalView\(item\)/.test(snippet)) throw new Error('Regression: duplicate legacy view call');
const uriA = 'spotify:track:' + 'A'.repeat(22), uriB = 'spotify:track:' + 'B'.repeat(22);
const itemA = { id: 'a', title: 'A', spotifyUri: uriA };
const itemB = { id: 'b', title: 'B', spotifyUri: uriB };

function fixture({policy = {}, item = itemA, active = false, activeItem = itemA, ready = true,
  fallback = false, failed = false, paused = false} = {}) {
  const calls = {legacy: 0, show: 0, play: 0, hide: 0, hideLegacy: 0, external: 0, sync: 0, status: []};
  const engine = {active, item: activeItem, playback: {item: activeItem, paused}};
  const local = {item, remoteManaged: false, paused: false};
  const audio = {
    hideInternalView: () => {calls.hideLegacy += 1;},
    getPlaybackState: () => fallback ? local : {item, remoteManaged: true},
    presentExternalTransport: (chosen, state) => {calls.external += 1;assert.equal(chosen, state.item);},
    playItem: async (chosen) => {
      calls.play += 1;
      if (failed) throw new Error('Expected playback failure');
      if (!fallback) {engine.active = true;engine.item=chosen;engine.playback={item:chosen,paused:false};}
      return true;
    }
  };
  const media = {fromItem: (value) => value?.spotifyUri ? {spotifyUri: value.spotifyUri} : null};
  const ctx = {
    audio,
    window: {EveAudioflixPlaybackPolicy: {resolve: () => policy}, EveAudioflixSpotifyMedia: media},
    originalOpenInternalView: async () => {calls.legacy += 1; return 'legacy';},
    isSpotify: value => !!media.fromItem(value),
    show: () => {calls.show += 1;return ready;},
    managed: () => ({snapshot: () => engine}),
    managedActive: () => engine.active,
    postMirrorState: () => {calls.sync += 1;},
    hide: () => {calls.hide += 1;},
    view: {setStatus: text => calls.status.push(String(text))}
  };
  const func = vm.runInNewContext('(' + functionSource + ')', ctx, {filename:'installed-internal-view.js'});
  return {calls, engine, run: () => func(item)};
}
async function go(){
  let count=0;
  const check = async (label, options, expectedResult, expected) => {
    const o=fixture(options);
    const actual = await o.run();
    assert.equal(actual,expectedResult,label);
    for(const [k,v] of Object.entries(expected)) assert.equal(o.calls[k],v,`${label}: ${k}`);
    console.log('PASS',label);count+=1;
  };
  await check('playing managed track: reveal without restart', {active:true}, true,
    {show:1,hideLegacy:1,play:0,legacy:0,external:0,sync:1});
  await check('paused managed track: no implicit resume', {active:true,paused:true}, true,
    {show:1,hideLegacy:1,play:0,legacy:0,external:0,sync:1});
  await check('different managed track: one routed Play', {active:true,activeItem:itemB}, true,
    {show:1,hideLegacy:1,play:1,legacy:0,external:0,sync:1});
  await check('idle engine: one routed Play', {}, true,
    {show:1,hideLegacy:1,play:1,legacy:0,external:0,sync:1});
  await check('localization fallback: one legacy transport, no second play', {fallback:true}, true,
    {show:1,hideLegacy:1,play:1,legacy:0,external:1,hide:1});
  await check('missing Engine panel: use original view', {ready:false}, 'legacy',
    {show:1,hideLegacy:0,play:0,legacy:1,external:0});
  await check('non-Spotify: use original view', {item:{id:'local',title:'Local',url:'file:///x.wav'}}, 'legacy',
    {show:0,hide:1,play:0,legacy:1,external:0});
  await check('Official Embed policy: use original view', {policy:{spotifyMethod:'embed'}}, 'legacy',
    {show:0,hide:1,play:0,legacy:1,external:0});
  {
    const o=fixture({failed:true});
    await assert.rejects(o.run(),/Expected playback failure/);
    assert.equal(o.calls.legacy,0);
    assert.equal(o.calls.show,1);
    assert.equal(o.calls.status.length,1);
    console.log('PASS managed errors remain on sole Engine panel');count++;
  }
  console.log('SPOTIFY_INTERNAL_VIEW_DEDUP_SMOKE_PASS',count);
}
go().catch(err => {console.error(err.stack || err); process.exitCode=1;});
