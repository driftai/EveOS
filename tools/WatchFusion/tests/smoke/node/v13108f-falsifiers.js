// v13.10.8f falsifiers: what the timing sensor may and may not claim. Red on v13.10.8e (fb921d0f): the clock
// "uncertainty" is minimum-RTT/2, which under-states the bound on the offset actually used and ignores asymmetric,
// stale, thin, coarse and unstable clocks; and group phase lets a muted room player vouch for a laptop whose sound
// comes from the source tab. Evidence type: Node VM only. Not Playwright, not Windows, not audible playback.
import {runR14sRecoveryChecks} from './r14s-resume-recovery.js';
import {runR14tStatusChecks} from './r14t-status-trust.js';
import {runR14uChecks} from './r14u-source-authority.js';
import {runR14vChecks} from './r14v-plateau-healing.js';
import {runR14wChecks} from './r14w-evidence.js';
import {runR14xChecks} from './r14x-recovery-ownership.js';
import {runR14yChecks} from './r14y-rate-convergence.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.WF_FALSIFIER_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The real core.js clock code (medianNumber .. watchPartyClock), driven by a simulated network.
function clockLab() {
  const src = read('public/client/core.js'), from = src.indexOf('function medianNumber'), start = src.indexOf('window.watchPartyClock = {');
  const end = src.indexOf('\n};', start) + 3;
  let wall = 1_000_000, mono = 0;
  const ctx = {window: {}, Math, Number, Date: {now: () => wall}, performance: {now: () => mono}};
  vm.runInNewContext('let serverClockSamples = [], serverClockReference = null, serverClockRttMs = null, serverClockOffsetMs = 0;\n' +
    src.slice(from, end) + '\nwindow.__update = updateServerClock;', ctx);
  const TRUE_OFFSET = 500;
  return {clock: ctx.window.watchPartyClock, trueOffset: TRUE_OFFSET,
    exchange(upMs, downMs, serverHoldMs = 1, receivedByServer = true, serverJumpMs = 0) {
      const t0 = wall; wall += upMs; mono += upMs;
      const t1 = wall + TRUE_OFFSET + serverJumpMs; wall += serverHoldMs; mono += serverHoldMs;
      const t2 = wall + TRUE_OFFSET + serverJumpMs; wall += downMs; mono += downMs;
      ctx.window.__update(t2, t0, wall, receivedByServer ? t1 : null);
      wall += 400; mono += 400;
    },
    wait(ms) { wall += ms; mono += ms; }};
}
function provenance() {
  const ctx = {Math, Number, performance: {now: () => 0}};
  ctx.globalThis = ctx; vm.runInNewContext(read('public/client/sensor-provenance.js'), ctx);
  return ctx.WatchFusionSensorProvenance;
}
function roomLog() {
  const element = () => ({value: '', textContent: '', open: false, addEventListener() {}, focus() {}, select() {}});
  const nodes = {syncRoomLog: element(), syncRoomLogText: element(), syncRoomLogCopy: element(), syncRoomLogClear: element(), syncRoomLogCount: element()};
  let now = 100000;
  const ctx = {document: {getElementById: id => nodes[id] || null}, navigator: {}, performance: {now: () => now},
    roomId: 'room-1', session: {memberId: 'h'}, isHost: () => true,
    state: {presentationEpoch: 1, playoutSegment: 6, hostId: 'h', playback: {rate: 1, position:60, projectedAt:now-10},
      members: [{id: 'h', name: 'Laptop-Side'}, {id: 'tv', name: 'TV'}, {id: 'ph', name: 'Phone'}]},
    estimatedServerNow: () => now, setTimeout, console, Date, JSON, Math, Object, Number, Array, String, RegExp};
  ctx.window = ctx;
  vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
  vm.runInNewContext(read('public/client/sync-room-log.js'), ctx, {filename: 'sync-room-log.js'});
  return {log: ctx.window.watchFusionRoomSyncLog, advance: ms => { now += ms; }, at: () => now};
}
const sensor = (audibleOutput, clock = {clockBoundMs: 6, clockState: 'bounded'}) => ({domain: 'player-timeline', heldMs: 0, audibleOutput, ...clock});
const peer = (member, at, targetError, audibleOutput = 'player', extra = {}) => ({member, playoutSegment:6, sampledAt: at - 10, positionMs: 60000 + targetError,
  roomPositionMs: 60000, targetPositionMs: 60000, ready: true, playing: true, buffering: false, rttMs: 10, rate: 1,
  audible: audibleOutput === 'player' || audibleOutput === 'both', sensor: sensor(audibleOutput), ...extra});
const snap = rows => { const {log, at} = roomLog(); log.observe(rows(at()), {reference: 'peer-cohort', source: 'live'}); return JSON.parse(log.export()).snapshots.at(-1); };

export async function runV13108fChecks(check) {
  await check('V13108F-01:clock-bound-holds-under-asymmetric-and-jittery-paths-where-min-rtt-half-does-not', () => {
    assert.equal(typeof provenance().clockBound, 'function', 'no clock bound classifier');
    let seed = 7; const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 40; trial++) {
      const lab = clockLab(), p = provenance();
      for (let i = 0; i < 8; i++) { const a = rand() < .5; lab.exchange(a ? 2 + rand() * 4 : 8 + rand() * 10, a ? 8 + rand() * 10 : 2 + rand() * 4); }
      const c = lab.clock.offsetBound(), d = p.clockBound(c), error = Math.abs(lab.clock.offsetMs() - lab.trueOffset);
      assert.ok(c && d.clockState === 'bounded', 'eight precise exchanges are a bounded clock');
      assert.ok(error <= d.clockBoundMs, `offset error ${error} exceeds reported bound ${d.clockBoundMs}`);
    }
    // One quick symmetric exchange sets the minimum; four slower one-sided exchanges inside the low-latency window
    // carry the median. The real error is then larger than minimum-RTT/2, which is what v13.10.8e reported.
    const skew = clockLab(); skew.exchange(2, 2); for (let i = 0; i < 4; i++) skew.exchange(1, 11);
    const skewError = Math.abs(skew.clock.offsetMs() - skew.trueOffset), skewBound = provenance().clockBound(skew.clock.offsetBound());
    assert.ok(skewError > skew.clock.rttMs() / 2, `fixture: error ${skewError} vs min-RTT/2 ${skew.clock.rttMs() / 2}`);
    assert.ok(skewError <= skewBound.clockBoundMs, 'the reported bound still covers it');
    const lab = clockLab();
    for (let i = 0; i < 5; i++) lab.exchange(1, 40);
    const d = provenance().clockBound(lab.clock.offsetBound()), error = Math.abs(lab.clock.offsetMs() - lab.trueOffset);
    assert.ok(error > 19 && error <= d.clockBoundMs, 'fully one-sided delay stays inside the bound; the asymmetry itself is not measured');
  });

  await check('V13108F-02:stale-thin-coarse-and-unstable-clocks-are-never-reported-as-bounded', () => {
    const p = provenance();
    let lab = clockLab(); for (let i = 0; i < 5; i++) lab.exchange(5, 5); lab.wait(20000);
    assert.equal(p.clockBound(lab.clock.offsetBound()).clockState, 'stale');
    lab = clockLab(); lab.exchange(5, 5); lab.exchange(5, 5);
    assert.equal(p.clockBound(lab.clock.offsetBound()).clockState, 'thin');
    lab = clockLab(); for (let i = 0; i < 5; i++) lab.exchange(5, 5, 1, false);
    assert.equal(p.clockBound(lab.clock.offsetBound()).clockState, 'coarse');
    lab = clockLab(); for (let i = 0; i < 5; i++) lab.exchange(5, 5, 1, true, i > 2 ? 300 : 0);
    assert.equal(p.clockBound(lab.clock.offsetBound()).clockState, 'unstable', 'offsets further apart than the bound allows');
    assert.deepEqual({...p.clockBound(null)}, {clockBoundMs: null, clockState: 'unknown'});
  });

  await check('V13108F-02B:clock exchanges qualify a witness only while precise stable and fresh', () => {
    const lab = clockLab();
    for (let i = 0; i < 4; i++) lab.exchange(15,15,1,false);
    assert.equal(lab.clock.witnessReady(),false,'coarse samples cannot qualify');
    lab.exchange(15,15);
    lab.exchange(15,15);
    assert.equal(lab.clock.witnessReady(),false,'two precise exchanges are insufficient');
    lab.exchange(15,15);
    assert.equal(lab.clock.witnessReady(),true);
    lab.wait(15000);
    assert.equal(lab.clock.witnessReady(),false,'old exchanges cannot qualify');
    const unstable = clockLab();
    for (let i = 0; i < 4; i++) unstable.exchange(15,15,1,true,i > 1 ? 200 : 0);
    assert.equal(unstable.clock.witnessReady(),false,'a shifting server offset cannot qualify');
  });

  await check('V13108F-03:clock diagnostics stay read-only and existing RTT limits still apply', () => {
    const files = ['public/client', 'src/server'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js')).map(f => dir + '/' + f));
    const allowed = new Set(['public/client/sensor-provenance.js', 'public/client/sync-room-log.js', 'public/client/sync-center.js',
      'public/client/core.js', 'public/client/presentation-sync.js', 'src/server/presentation-report-schema.js']);
    for (const file of files) {
      if (/clockBound|clockState|offsetBound|groupPhase|audibleOutput/.test(read(file))) assert.ok(allowed.has(file), file + ' consumes a diagnostic sensor field');
    }
    const ps = read('public/client/presentation-sync.js');
    assert.equal((ps.match(/offsetBound|clockBound|clockState/g) || []).length, 1, 'presentation-sync only forwards the bound into the report');
    const precision = read('public/client/precision-policy.js');
    assert.match(precision, /!finite\(p\.rttMs\) \|\| p\.rttMs >= 90/, 'peer-proposal RTT gate unchanged');
    assert.match(ps, /sample\.rttMs <= 45\)/, 'measured-adjustment RTT gate unchanged');
    const center = read('public/client/sync-center.js');
    assert.match(center, /\(estimated\)/); assert.doesNotMatch(center, /accuracy|calibrat/i);
  });

  await check('V13108F-04:group-phase-only-counts-players-that-are-themselves-audible', () => {
    let s = snap(at => [peer('h', at, -130, 'source-tab'), peer('tv', at, -128)]);
    assert.equal(s.groupPhase, 'unmeasured-single-player', 'a muted room player cannot vouch for source-tab audio');
    assert.equal(s.outputs, 'source-tab-audible');
    s = snap(at => [peer('h', at, -130), peer('tv', at, -128)]);
    assert.equal(s.groupPhase, 'common-mode-offset'); assert.equal(s.outputs, 'room-players');
    s = snap(at => [peer('h', at, -10, 'both'), peer('tv', at, 5)]);
    assert.equal(s.groupPhase, 'aligned'); assert.equal(s.outputs, 'double-audio', 'double audio is flagged even when players agree');
    s = snap(at => [peer('h', at, -10, 'none'), peer('tv', at, 5, 'none'), peer('ph', at, 0)]);
    assert.equal(s.groupPhase, 'unmeasured-single-player'); assert.equal(s.outputs, 'room-players');
    s = snap(at => [peer('h', at, -10), peer('tv', at - 5000, 5)]);
    assert.equal(s.groupPhase, 'unmeasured-single-player', 'stale participant');
    s = snap(at => [peer('h', at, -10, 'unknown'), peer('tv', at, 5)]);
    assert.equal(s.groupPhase, 'unmeasured-single-player'); assert.equal(s.outputs, 'unknown');
    for (const row of [s]) assert.equal(row.speakerPhase, 'not-measured');
  });

  await check('V13108F-05:unbounded-clocks-cannot-produce-aligned-or-disagree-verdicts', () => {
    const unbounded = (member, at, err, state) => peer(member, at, err, 'player', {sensor: sensor('player', {clockBoundMs: 6, clockState: state})});
    for (const state of ['stale', 'thin', 'coarse', 'unstable', 'unknown']) {
      const s = snap(at => [peer('h', at, -10), unbounded('tv', at, 5, state)]);
      assert.equal(s.groupPhase, 'unmeasured-clock', state + ' clock must not certify alignment');
      assert.equal(s.groupUncertaintyMs, null);
    }
  });

  await check('V13108F-06:an-output-route-change-is-recorded-at-once', () => {
    const {log, at, advance} = roomLog();
    log.observe([peer('h', at(), -10), peer('tv', at(), 5)], {reference: 'peer-cohort', source: 'live'});
    advance(500);
    log.observe([peer('h', at(), -10, 'source-tab'), peer('tv', at(), 5)], {reference: 'peer-cohort', source: 'live'});
    const shots = JSON.parse(log.export()).snapshots;
    assert.deepEqual(shots.map(x => x.outputs), ['room-players', 'source-tab-audible'], 'the switch is evidence and is not deferred 4.5 s');
    assert.equal(shots.at(-1).speakerPhase, 'not-measured', 'a Bluetooth/HDMI route change inside one output is still not observable');
  });
  await runR14sRecoveryChecks(check);
  await runR14tStatusChecks(check);
  await runR14uChecks(check);
  await runR14vChecks(check);
  await runR14wChecks(check);
  await runR14xChecks(check);
  await runR14yChecks(check);
}
