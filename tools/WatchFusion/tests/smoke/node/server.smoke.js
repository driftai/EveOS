import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server-harness.js';
import {
  request,
  createRoom,
  joinRoom,
  getRoom,
  sendCommand,
  pingMember,
  leaveRoom,
  openSseStream
} from '../helpers/http-client.js';
import { YOUTUBE_FIXTURES } from '../fixtures/youtube.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 19185;

export async function runNodeSmokes() {
  const results = [];
  const record = (id, fn) => async () => {
    try {
      await fn();
      results.push({ id, status: 'PASS' });
    } catch (err) {
      results.push({ id, status: 'FAIL', error: err.message });
    }
  };

  const server = await startServer({ port: PORT, host: '127.0.0.1' });
  const baseUrl = server.baseUrl;

  try {
    // 1. Server startup, root redirect, and canonical host HTML serving
    await record('NODE-01:server-startup-and-root', async () => {
      // Loopback 127.0.0.1 navigations redirect to 127-0-0-1.sslip.io
      const redirectRes = await request(baseUrl, '/');
      assert.equal(redirectRes.status, 302, 'Local loopback navigation must 302 redirect to sslip.io host');
      assert.ok(redirectRes.headers.location?.includes('127-0-0-1.sslip.io'), 'Location header targets 127-0-0-1.sslip.io');

      // Canonical host returns 200 with HTML document
      const htmlRes = await request(baseUrl, '/', {
        headers: { host: `127-0-0-1.sslip.io:${PORT}` }
      });
      assert.equal(htmlRes.status, 200, 'Canonical host returns status 200');
      assert.ok(htmlRes.body.toLowerCase().includes('<!doctype html>'), 'Canonical host returns HTML');
      assert.ok(htmlRes.body.includes('WatchParty'), 'Root HTML contains WatchParty');
    })();

    // 2. Static asset serving and path security
    await record('NODE-02:static-assets-and-security', async () => {
      const css = await request(baseUrl, '/style.css');
      assert.equal(css.status, 200, '/style.css must be reachable');
      assert.ok(css.headers['content-type']?.includes('text/css'), 'CSS content type');

      const js = await request(baseUrl, '/app.js');
      assert.equal(js.status, 200, '/app.js must be reachable');
      assert.ok(js.headers['content-type']?.includes('javascript'), 'JS content type');

      const traversal = await request(baseUrl, '/../../server.js');
      assert.ok([400, 403, 404].includes(traversal.status), 'Directory traversal must be rejected');

      const missing = await request(baseUrl, '/non-existent-file.xyz');
      assert.equal(missing.status, 404, 'Missing file must return 404');
    })();

    // 3. Health endpoint
    await record('NODE-03:health-endpoint', async () => {
      const res = await request(baseUrl, '/api/health');
      assert.equal(res.status, 200, 'Health endpoint returns 200');
      assert.equal(res.json?.ok, true, 'Health ok is true');
      assert.equal(typeof res.json?.rooms, 'number', 'Reports room count');
      assert.equal(res.json?.youtubePlayer, 'iframe-api', 'Reports iframe-api player');
    })();

    // 4. Network-info endpoint
    await record('NODE-04:network-info-endpoint', async () => {
      const res = await request(baseUrl, '/api/network-info');
      assert.equal(res.status, 200, 'Network info returns 200');
      assert.equal(res.json?.ok, true, 'Network info ok is true');
      assert.equal(res.json?.port, PORT, 'Reports correct port');
      assert.ok(res.json?.localAddress, 'Reports localAddress');
      assert.ok(res.json?.localHost, 'Reports localHost');
      assert.equal(res.json?.localMode, true, 'Local mode is active by default');
    })();

    // 5. CORS headers on API requests
    await record('NODE-05:cors-preflight-and-headers', async () => {
      const optionsRes = await request(baseUrl, '/api/rooms/test/join', { method: 'OPTIONS' });
      assert.equal(optionsRes.status, 204, 'OPTIONS preflight returns 204');
      assert.equal(optionsRes.headers['access-control-allow-origin'], '*', 'CORS allow-origin wildcard');

      const getRes = await request(baseUrl, '/api/network-info');
      assert.equal(getRes.headers['access-control-allow-origin'], '*', 'GET API returns CORS header');
    })();

    // 6. Room creation and duplicate handling
    const testRoomId = 'SMOKE1';
    const testRoomCode = '701';
    await record('NODE-06:room-creation-and-aliases', async () => {
      const createRes = await createRoom(baseUrl, testRoomId, {
        name: 'SmokeHost',
        roomCode: testRoomCode,
        accountId: 'acc-smoke-host-1'
      });
      assert.equal(createRes.status, 201, 'Room creation returns 201');
      assert.equal(createRes.json?.roomId, testRoomId, 'Returns roomId');
      assert.equal(createRes.json?.roomCode, testRoomCode, 'Returns roomCode alias');

      // Conflict test
      const duplicateRes = await createRoom(baseUrl, 'OTHER_ID', {
        name: 'Imposter',
        roomCode: testRoomCode
      });
      assert.equal(duplicateRes.status, 409, 'Duplicate roomCode returns 409');
    })();

    // 7. Room join, host assignment, and state retrieval
    let hostMemberId = null;
    let viewerMemberId = null;
    let viewerPublicId = null;
    await record('NODE-07:room-join-and-ownership', async () => {
      // Host joins
      const hostJoin = await joinRoom(baseUrl, testRoomCode, {
        name: 'AliceHost',
        accountId: 'acc-alice'
      });
      assert.equal(hostJoin.status, 200, 'Host joins successfully');
      hostMemberId = hostJoin.json?.session?.memberId;
      assert.ok(hostMemberId, 'Host receives memberId');
      assert.equal(hostJoin.json?.session?.isOwner, true, 'First joiner is owner');
      assert.equal(hostJoin.json?.state?.hostId, hostJoin.json?.session?.publicId || hostMemberId, 'First joiner is host');

      // Viewer joins using numeric roomCode
      const viewerJoin = await joinRoom(baseUrl, testRoomCode, {
        name: 'BobViewer',
        accountId: 'acc-bob'
      });
      assert.equal(viewerJoin.status, 200, 'Viewer joins successfully');
      viewerMemberId = viewerJoin.json?.session?.memberId;
      viewerPublicId = viewerJoin.json?.session?.publicId;
      assert.ok(viewerMemberId, 'Viewer receives memberId');
      assert.equal(viewerJoin.json?.session?.isOwner, false, 'Viewer is not owner');
      assert.equal(viewerJoin.json?.state?.members.length, 2, 'Two members present');

      // Retrieve state
      const stateRes = await getRoom(baseUrl, testRoomId);
      assert.equal(stateRes.status, 200, 'Get room state returns 200');
      assert.equal(stateRes.json?.state?.roomId, testRoomId);
      assert.equal(stateRes.json?.state?.members.length, 2);
    })();

    // 8. Member heartbeat ping
    await record('NODE-08:member-ping', async () => {
      const pingRes = await pingMember(baseUrl, testRoomId, hostMemberId);
      assert.equal(pingRes.status, 200, 'Ping returns 200');
      assert.equal(pingRes.json?.ok, true);
    })();

    // 9. Video source command
    await record('NODE-09:video-source-command', async () => {
      // Non-host cannot set source
      const forbiddenRes = await sendCommand(baseUrl, testRoomId, viewerMemberId, {
        type: 'source',
        input: YOUTUBE_FIXTURES.valid[0].input
      });
      assert.equal(forbiddenRes.status, 403, 'Non-host cannot set source');

      // Host sets valid source
      const okRes = await sendCommand(baseUrl, testRoomId, hostMemberId, {
        type: 'source',
        input: YOUTUBE_FIXTURES.valid[0].input
      });
      assert.equal(okRes.status, 200, 'Host sets source successfully');
      assert.equal(okRes.json?.state?.source?.videoId, YOUTUBE_FIXTURES.valid[0].expectedId);
      assert.equal(okRes.json?.state?.playback?.paused, true, 'New video starts paused');
      assert.equal(okRes.json?.state?.playback?.position, 0, 'New video starts at 0');

      // Invalid source returns 400
      const badRes = await sendCommand(baseUrl, testRoomId, hostMemberId, {
        type: 'source',
        input: 'not-a-valid-video'
      });
      assert.equal(badRes.status, 400, 'Invalid source returns 400');
    })();

    // 10. Playback synchronization (play, seek, pause, rate)
    await record('NODE-10:playback-commands-and-projection', async () => {
      // Play
      const playRes = await sendCommand(baseUrl, testRoomId, hostMemberId, {
        type: 'play',
        position: 10
      });
      assert.equal(playRes.status, 200);
      assert.equal(playRes.json?.state?.playback?.paused, false);

      // Wait a moment and check projected position
      await new Promise(r => setTimeout(r, 200));
      const projectedState = await getRoom(baseUrl, testRoomId);
      assert.ok(projectedState.json?.state?.playback?.position > 10, 'Projected position advances');

      // Seek
      const seekRes = await sendCommand(baseUrl, testRoomId, hostMemberId, {
        type: 'seek',
        position: 50
      });
      assert.equal(seekRes.status, 200);
      assert.ok(seekRes.json?.state?.playback?.position >= 50, 'Seek position updated');

      // Rate
      const rateRes = await sendCommand(baseUrl, testRoomId, hostMemberId, {
        type: 'rate',
        rate: 1.5
      });
      assert.equal(rateRes.status, 200);
      assert.equal(rateRes.json?.state?.playback?.rate, 1.5, 'Playback rate set to 1.5');

      // Pause
      const pauseRes = await sendCommand(baseUrl, testRoomId, hostMemberId, {
        type: 'pause',
        position: 60
      });
      assert.equal(pauseRes.status, 200);
      assert.equal(pauseRes.json?.state?.playback?.paused, true);
      assert.equal(pauseRes.json?.state?.playback?.position, 60);
    })();

    // 11. Chat messaging
    await record('NODE-11:chat-messaging', async () => {
      const chatRes = await sendCommand(baseUrl, testRoomId, viewerMemberId, {
        type: 'chat',
        text: 'Hello from viewer!'
      });
      assert.equal(chatRes.status, 200);
      const messages = chatRes.json?.state?.messages;
      assert.ok(messages?.length >= 1);
      assert.equal(messages[messages.length - 1].text, 'Hello from viewer!');
      assert.equal(messages[messages.length - 1].name, 'BobViewer');

      // Empty chat error
      const emptyRes = await sendCommand(baseUrl, testRoomId, viewerMemberId, {
        type: 'chat',
        text: '   '
      });
      assert.equal(emptyRes.status, 400);
    })();

    // 12. Server-Sent Events (SSE) delivery
    await record('NODE-12:sse-events-delivery', async () => {
      let receivedState = null;
      const sse = openSseStream(baseUrl, testRoomId, viewerMemberId, data => {
        if (data.type === 'state') receivedState = data.state;
      });

      // Give SSE connection a tick to establish
      await new Promise(r => setTimeout(r, 150));
      assert.ok(receivedState, 'SSE delivered initial state');

      // Trigger command and verify update is pushed
      await sendCommand(baseUrl, testRoomId, hostMemberId, {
        type: 'chat',
        text: 'SSE broadcast test'
      });
      await new Promise(r => setTimeout(r, 150));
      assert.ok(receivedState?.messages?.some(m => m.text === 'SSE broadcast test'), 'SSE delivered updated state');

      sse.close();
    })();

    // 13. Member leave and host handoff
    await record('NODE-13:member-leave-and-handoff', async () => {
      const leaveRes = await leaveRoom(baseUrl, testRoomId, hostMemberId);
      assert.equal(leaveRes.status, 200);
      const state = await getRoom(baseUrl, testRoomId);
      assert.equal(state.json?.state?.members.length, 1);
      assert.equal(state.json?.state?.hostId, viewerPublicId || viewerMemberId, 'Host transferred to remaining member');
      assert.equal(state.json?.state?.temporaryHost, true, 'Remaining member marked as temporary host');
    })();

    // 14. Room deletion
    await record('NODE-14:room-deletion', async () => {
      const delRes = await sendCommand(baseUrl, testRoomId, viewerMemberId, {
        type: 'delete-room'
      });
      assert.equal(delRes.status, 200);
      assert.equal(delRes.json?.deleted, true);

      const stateAfter = await getRoom(baseUrl, testRoomId);
      assert.ok([404, 410].includes(stateAfter.status), 'Deleted room returns 404 or 410');
    })();

    // 15. Stale member grace period configuration regression check
    await record('NODE-15:stale-member-grace-window', async () => {
      const configPath = path.resolve(__dirname, '../../../src/server/config.js');
      const serverPath = path.resolve(__dirname, '../../../server.js');
      const source = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : fs.readFileSync(serverPath, 'utf8');
      assert.ok(
        /MEMBER_STALE_MS\s*=\s*120\s*\*\s*1000/.test(source),
        'MEMBER_STALE_MS must be 120 seconds (120 * 1000)'
      );
    })();

  } finally {
    await server.stop();
  }

  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runNodeSmokes().then(results => {
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    if (failed > 0) {
      console.error(`NODE SMOKE FAILED: ${passed} passed, ${failed} failed.`);
      for (const r of results.filter(r => r.status === 'FAIL')) {
        console.error(`  - ${r.id}: ${r.error}`);
      }
      process.exit(1);
    } else {
      console.log(`NODE SMOKE PASSED: ${passed}/${results.length} tests passed.`);
    }
  });
}
