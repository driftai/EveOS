import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../helpers/server-harness.js';
import { request, createRoom, joinRoom, leaveRoom, sendCommand } from '../helpers/http-client.js';

async function client(base, credentials) {
  const socket = new WebSocket(base.replace('http', 'ws') + '/live-ws');
  const messages = [], waiters = [];
  socket.on('message', raw => { const data = JSON.parse(raw); messages.push(data); waiters.splice(0).forEach(fn => fn()); });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'join', ...credentials }));
  return { socket, messages, send: data => socket.send(JSON.stringify(data)), async take(type) {
    const started = Date.now();
    while (Date.now() - started < 2500) {
      const index = messages.findIndex(message => message.type === type);
      if (index !== -1) return messages.splice(index, 1)[0];
      await new Promise(resolve => { const timer = setTimeout(resolve, 30); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
    throw new Error(`Timed out waiting for ${type}`);
  } };
}
export async function runLiveSmokes() {
  const results = [], clients = [];
  const server = await startServer({ port: 19193 });
  const base = server.baseUrl;
  const check = async (id, fn) => { try { await fn(); results.push({ id, status: 'PASS' }); } catch (error) { results.push({ id, status: 'FAIL', error: error.message }); } };
  const connect = async credentials => { const c = await client(base, credentials); clients.push(c); return c; };
  const post = (path, body, memberId) => request(base, path, { method: 'POST', body, headers: memberId ? { 'x-member-id': memberId } : {} });
  try {
    await check('LIVE-01:room-isolation-and-host-control', async () => {
      const made = await post('/api/live', {}); assert.equal(made.status, 201); const live = made.json;
      await createRoom(base, 'LIVEA');
      const host = (await joinRoom(base, 'LIVEA', { name: 'Host' })).json.session;
      const guest = (await joinRoom(base, 'LIVEA', { name: 'Guest' })).json.session;
      assert.equal((await post(`/api/live/${live.id}/room`, { publisherToken: live.publisherToken, roomId: 'LIVEA' }, guest.memberId)).status, 403);
      const attach = await post(`/api/live/${live.id}/room`, { publisherToken: live.publisherToken, roomId: 'LIVEA', mode: 'audioflix' }, host.memberId);
      assert.equal(attach.status, 200); assert.equal(attach.json.state.source.kind, 'live');
      assert.ok(!JSON.stringify(attach.json.state).includes(live.publisherToken));
      assert.ok(!JSON.stringify(attach.json.state).includes(live.viewerToken));
      const publisher = await connect({ id: live.id, role: 'publisher', token: live.publisherToken }); await publisher.take('ready');
      const sentAt = Date.now(); publisher.send({type:'ping',sentAt});
      const clock = await publisher.take('pong');
      assert.equal(clock.sentAt,sentAt); assert.ok(clock.receivedAt > 0 && clock.serverTime >= clock.receivedAt);
      const viewer = await connect({ id: live.id, roomId: 'LIVEA', memberId: guest.memberId }); await viewer.take('ready');
      const joined = await publisher.take('viewer');
      publisher.send({ type: 'signal', peer: joined.peer, signal: { description: { type: 'offer', sdp: 'test-offer' } } });
      assert.equal((await viewer.take('signal')).signal.description.sdp, 'test-offer');
      viewer.send({ type: 'signal', signal: { description: { type: 'answer', sdp: 'test-answer' } } });
      assert.equal((await publisher.take('signal')).signal.description.sdp, 'test-answer');
      publisher.send({ type: 'metadata', metadata: { title: 'Song', queue: [{ id: '1', title: 'Track', localPath: 'private' }], localPath: 'private' } });
      await viewer.take('metadata');
      const meta = await viewer.take('metadata'); assert.equal(meta.metadata.title, 'Song'); assert.ok(!JSON.stringify(meta).includes('private'));
      viewer.messages.length = 0; viewer.send({ type: 'control', action: 'next' });
      assert.match((await viewer.take('status')).status, /Only the host/);
      const controller = await connect({ id: live.id, roomId: 'LIVEA', memberId: host.memberId }); await controller.take('ready');
      controller.send({ type: 'control', action: 'next' }); assert.equal((await publisher.take('control')).action, 'next');
      // A second room cannot steal a stream by guessing its non-secret ID.
      await createRoom(base, 'LIVEB'); const other = (await joinRoom(base, 'LIVEB', { name: 'Other' })).json.session;
      await sendCommand(base, 'LIVEB', other.memberId, { type: 'source', source: { kind: 'live', streamId: live.id } });
      const intruder = await connect({ id: live.id, roomId: 'LIVEB', memberId: other.memberId });
      const closed = await new Promise(resolve => intruder.socket.once('close', code => resolve(code))); assert.equal(closed, 1008);
      assert.equal((await post(`/api/live/${live.id}/stop`, { publisherToken: 'wrong' })).status, 403);
      assert.equal((await post(`/api/live/${live.id}/stop`, live)).status, 200);
    });
    await check('LIVE-02:cross-site-create-rejected-and-bundle-valid', async () => {
      const bad = await request(base, '/api/live', { method: 'POST', body: {}, headers: { origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' } });
      assert.equal(bad.status, 403);
      const bundle = await request(base, '/app.js'); assert.equal(bundle.status, 200); new Function(bundle.body);
      const helper = await request(base, '/live-peer.js'); assert.equal(helper.status, 200); new Function(helper.body);
      const html = await request(base, '/');
      assert.match(html.body, /id="linkTabBtn"/); assert.match(html.body, /id="linkAudioflixBtn"/);
      assert.match(html.body, /id="unloadMediaBtn"/); assert.match(html.body, /id="livePairClose"/);
      assert.match(html.body, /id="livePairFolder"/); assert.doesNotMatch(html.body, /live-help\.html/);
    });
    await check('LIVE-03:linked-source-ownership-survives-host-handoff-and-rejoin', async () => {
      const roomId = 'LINKEDLAN';
      const accountId = 'synthetic-laptop';
      await createRoom(base, roomId);
      const laptop = (await joinRoom(base, roomId, { name: 'Laptop', accountId })).json.session;
      const tv = (await joinRoom(base, roomId, { name: 'TV' })).json.session;
      const live = (await post('/api/live', {})).json;
      const linkedSource = { id: live.id, token: live.publisherToken };
      const bind = { publisherToken: live.publisherToken, roomId, mode: 'linked-tab' };
      assert.equal((await post(`/api/live/${live.id}/room`, bind, tv.memberId)).status, 403);
      const bound = await post(`/api/live/${live.id}/room`, bind, laptop.memberId);
      assert.equal(bound.status, 200);
      assert.equal(bound.json.state.linkedSourceActive, true);
      assert.ok(!JSON.stringify(bound.json.state).includes(live.publisherToken));
      const handoff = await sendCommand(base, roomId, laptop.memberId, { type: 'transfer-host', targetMemberId: tv.publicId });
      assert.equal(handoff.status, 200);
      assert.equal(handoff.json.state.hostId, tv.publicId);

      const resumed = await joinRoom(base, roomId, { name: 'Laptop', accountId, memberId: laptop.memberId });
      assert.equal(resumed.json.state.hostId, tv.publicId);
      assert.equal(resumed.json.state.revision, handoff.json.state.revision);
      const poll = memberId => request(base, `/api/rooms/${roomId}/state`, { headers: { 'x-member-id': memberId } });
      assert.equal((await poll(tv.publicId)).status, 401);
      assert.equal((await poll(laptop.memberId)).json.state.revision, handoff.json.state.revision);
      assert.equal((await sendCommand(base, roomId, tv.publicId, { type: 'play' })).status, 401);
      assert.equal((await sendCommand(base, roomId, laptop.memberId, { type: 'transfer-host', targetMemberId: laptop.publicId })).status, 403);
      assert.equal((await sendCommand(base, roomId, laptop.memberId, { type: 'delete-room' })).status, 403);
      const reload = await post(`/api/rooms/${roomId}/leave?defer=1`, {}, tv.memberId);
      assert.equal(reload.status, 202);
      const resumedTv = await joinRoom(base, roomId, { name: 'TV', accountId: tv.accountId, memberId: tv.memberId });
      assert.equal(resumedTv.json.state.hostId, tv.publicId);
      assert.equal(resumedTv.json.state.revision, handoff.json.state.revision);

      const source = { type: 'source', input: 'M7lc1UVf-VE', linkedSource };
      assert.equal((await sendCommand(base, roomId, tv.memberId, source)).status, 403);
      assert.equal((await sendCommand(base, roomId, laptop.memberId, source)).status, 200);
      const mirror = { type: 'mirror', position: 30, paused: false, linkedSource };
      assert.equal((await sendCommand(base, roomId, laptop.memberId, { ...mirror, linkedSource: { id: live.id, token: 'wrong' } })).status, 403);
      const mirrored = await sendCommand(base, roomId, laptop.memberId, mirror);
      assert.equal(mirrored.status, 200);
      assert.equal(mirrored.json.state.playback.paused, false);
      assert.equal(mirrored.json.state.hostId, tv.publicId);
      assert.equal((await post(`/api/live/${live.id}/stop`, live)).status, 200);
      assert.equal((await sendCommand(base, roomId, laptop.memberId, mirror)).status, 403);
      assert.equal((await poll(tv.memberId)).json.state.linkedSourceActive, false);
      assert.equal((await leaveRoom(base, roomId, tv.memberId)).status, 200);
      assert.equal((await poll(laptop.memberId)).json.state.hostId, laptop.publicId);
    });
  } finally { for (const c of clients) c.socket.close(); await server.stop(); }
  return results;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await runLiveSmokes();
  const failed = results.filter(result => result.status !== 'PASS');
  for (const result of failed) console.error(`${result.id}: ${result.error}`);
  console.log(`WATCHFUSION LIVE: PASS ${results.length - failed.length} | FAIL ${failed.length}`);
  process.exitCode = failed.length ? 1 : 0;
}
