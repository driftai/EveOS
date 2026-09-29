import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../helpers/server-harness.js';
import { request, createRoom, joinRoom, sendCommand } from '../helpers/http-client.js';

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
      const html = await request(base, '/'); assert.match(html.body, /id="linkTabBtn"/); assert.match(html.body, /id="linkAudioflixBtn"/);
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
