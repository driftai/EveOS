import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { handleRoomRoute } from '../../../src/server/room-routes.js';

const client = name => fs.readFileSync(new URL('../../../public/client/' + name, import.meta.url), 'utf8');

function phrase() {
  let state = 42, floor = 0, target = 0;
  return Float32Array.from({length:12000}, (_, time) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    if (time % (37 + (time % 19)) === 0) target = (state >>> 16) / 65535;
    floor += (target - floor) * .15;
    return floor;
  });
}

const performanceData = phrase();
function recording(start, stretch = 1, volume = 1) {
  return Float32Array.from({length:5000}, (_, index) => {
    const at = start + Math.round(index * stretch);
    return performanceData[at] * volume + .07 * performanceData[at - 16] + .015 * Math.cos(index / 7);
  });
}

const sample = (positionMs = 5000, roomPositionMs = positionMs, extra = {}) =>
  ({positionMs, roomPositionMs, rate:1, rttMs:4, jitterMs:2, ...extra});

async function request(room, action, body, memberId) {
  const url = new URL('http://localhost/api/rooms/' + room + (action ? '/' + action : ''));
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), {
    method: body ? 'POST' : 'GET', headers: memberId ? {'x-member-id':memberId} : {}
  });
  const response = {
    writeHead(code, headers) { this.status = code; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); }
  };
  await handleRoomRoute(req, response, url, url.pathname.split('/').filter(Boolean));
  return response;
}

export async function runPresentationTimingChecks(check) {
  const space = vm.createContext({});
  vm.runInContext(client('acoustic-timing.js'), space);
  const acoustics = space.WatchFusionAcoustics;
  const baseline = recording(3000);

  await check('PRESENT-01:room player phase is separated from 850 ms output delay', () => {
    const tv = recording(3000 + 260 - 850, 1, .6);
    const match = acoustics.estimate(baseline, tv, -260);
    assert.ok(match);
    assert.ok(Math.abs(match.lagMs - 590) <= 3);
    const result = acoustics.measure(sample(), sample(5260, 5150), match);
    assert.ok(Math.abs(result.observedMs - 850) <= 3);
    assert.ok(Math.abs(result.adjustmentMs + 850) <= 3);
    assert.ok(Math.abs(result.residualMs - 740) <= 3);
  });

  await check('PRESENT-02:15 ms offset keeps its direction; reference phase is included', () => {
    const phone = recording(3000 + 15, 1, .82);
    const result = acoustics.measure(sample(), sample(), acoustics.estimate(baseline, phone));
    assert.ok(result && Math.abs(result.adjustmentMs - 15) <= 3);
    const phase = acoustics.measure(sample(5100, 5000), sample(), acoustics.estimate(baseline, baseline));
    assert.equal(phase.adjustmentMs, 0, 'referenced media position difference is not attributed twice');
    const sameOutput = acoustics.measure(sample(5100, 5000), sample(), acoustics.estimate(baseline, recording(2900), 100));
    assert.ok(Math.abs(sameOutput.adjustmentMs + 100) <= 3, JSON.stringify(sameOutput));
  });

  await check('PRESENT-03:insufficient, periodic, drifting or noisy samples cannot change timing', () => {
    const periodic = Float32Array.from({length:5000}, (_, i) => Math.sin(i / 19));
    assert.equal(acoustics.estimate(periodic, periodic), null);
    assert.equal(acoustics.estimate(baseline, new Float32Array(5000)), null);
    assert.equal(acoustics.estimate(baseline, recording(3000, 1.07)), null);
    assert.equal(acoustics.estimate(baseline, recording(3000).reverse()), null);
    const match = {lagMs:850, uncertaintyMs:5, matches:7};
    assert.equal(acoustics.measure(sample(), sample(5000, 5000, {rttMs:60}), match), null);
    assert.equal(acoustics.measure(sample(), sample(5000, 5000, {rate:1.25}), match), null);
  });

  await check('PRESENT-04:common playout target delays only controllable outputs', () => {
    const paths = [['laptop',0],['tv',850],['phone',-15]].map(([id, latencyMs]) =>
      ({id, latencyMs, delayable:true, uncertaintyMs:8}));
    assert.deepEqual(Array.from(acoustics.commonTarget(paths), path => path.delayMs), [850,0,865]);
    assert.equal(acoustics.commonTarget(paths.map(path => ({...path, delayable:false}))), null);
    assert.equal(acoustics.commonTarget(paths.map(path => ({...path, uncertaintyMs:50}))), null);
  });

  await check('PRESENT-05:worklet sends bounded features and leaves playback output silent', () => {
    let Processor, received;
    const environment = vm.createContext({
      AudioWorkletProcessor: class { port = {postMessage: (data, transfer) => { received = {data,transfer}; }}; },
      registerProcessor: (_, implementation) => { Processor = implementation; },
      currentFrame:0, sampleRate:44100
    });
    vm.runInContext(client('acoustic-microphone.worklet.js'), environment);
    const processor = new Processor(), output = new Float32Array(128);
    processor.port.onmessage({data:'record'});
    for (let i = 0; i < 1730; i++) {
      environment.currentFrame = i * 128;
      const input = new Float32Array(128).fill(i % 2 ? .2 : .05);
      assert.equal(processor.process([[input]], [[output]]), true);
    }
    assert.ok(received);
    assert.equal(received.data.envelope.length, 5000);
    assert.equal(received.transfer[0].byteLength, 20000);
    assert.equal(received.data.time, 0);
    assert.ok(received.data.envelope.every(Number.isFinite));
    assert.ok(output.every(value => value === 0));
  });

  await check('PRESENT-06:route requires membership, sends selected viewer only, and fences source/host changes', async () => {
    const created = await request('PRESENTATION-TEST', 'create', {});
    const room = created.body.roomId;
    const host = (await request(room, 'join', {name:'Host',accountId:'host-present-testing'})).body.session;
    const tv = (await request(room, 'join', {name:'Viewer',accountId:'tv-present-testing'})).body.session;
    const phone = (await request(room, 'join', {name:'Second',accountId:'phone-present-testing'})).body.session;
    const cmd = (body, session = host) => request(room,'command',body,session.memberId);
    const source = {type:'source',input:'rm7UdTLKt5Y'};
    const {state} = (await cmd(source)).body;
    const epoch = state.presentationEpoch;
    const read = (member, body = {}, expected = epoch) => request(room,'presentation', {epoch:expected,...body}, member?.memberId);
    const post = (member, extra = {}) => read(member,{report:{
      ...sample(), mode:'youtube', outputSession:'device-for-' + member.publicId, sampledAt:Date.now(), ready:true, playing:true, follows:member !== host,
      ...extra
    }});
    try {
      assert.equal((await read()).status, 401);
      assert.equal((await post(host, {rate:0})).status, 400);
      assert.equal((await post(host, {sampledAt:Date.now() - 5000})).status, 400);
      assert.equal((await post(host)).status, 200);
      assert.equal((await post(tv, {rate:1.25,envelope:[42]})).status, 200);
      const token = {target:tv.publicId,outputSession:'device-for-' + tv.publicId,id:'calibration-123',adjustmentMs:-850,observedMs:850,uncertaintyMs:12};
      assert.equal((await read(tv,{proposal:token})).status, 403);
      assert.equal((await read(host,{proposal:token})).status, 200);
      const viewer = await read(tv);
      assert.equal(viewer.body.proposal.adjustmentMs, -850);
      assert.equal(viewer.body.peers.find(peer => peer.member === tv.publicId).rate, 1.25);
      assert.equal(viewer.headers['Cache-Control'], 'no-store');
      assert.doesNotMatch(JSON.stringify(viewer.body), /envelope|host-present-testing/);
      assert.equal((await read(phone)).body.proposal, null);
      assert.equal((await read(tv,{dismiss:token.id})).body.proposal, null);
      assert.equal((await read(host,{proposal:token})).status, 200);
      const changedAt = Date.now();
      assert.equal((await post(tv,{outputSession:'new-output-123',sampledAt:changedAt + 5})).status, 200);
      assert.equal((await read(tv)).body.proposal, null);
      assert.equal((await read(host,{proposal:token})).status, 409);
      const transfer = await cmd({type:'transfer-host',targetMemberId:phone.publicId});
      const newEpoch = transfer.body.state.presentationEpoch;
      assert.notEqual(newEpoch, epoch);
      assert.equal((await read(tv)).status, 409);
      assert.deepEqual((await read(tv,{},newEpoch)).body.peers, []);
      const changed = await cmd(source,phone);
      assert.notEqual(changed.body.state.presentationEpoch, newEpoch, 'same-URL reload invalidates prior calibration');
      assert.equal((await read(tv,{},changed.body.state.presentationEpoch)).body.proposal, null);
    } finally {
      await cmd({type:'delete-room'}, phone);
      await cmd({type:'delete-room'}, host);
    }
  });
}
