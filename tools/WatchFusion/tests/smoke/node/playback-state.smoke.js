import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.js';
import { createRoom, joinRoom, sendCommand, request } from '../helpers/http-client.js';
import { YOUTUBE_FIXTURES } from '../fixtures/youtube.js';

const PORT = 19186;

export async function runPlaybackStateSmokes() {
  const results = [];
  const record = async (id, fn) => {
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
    let hostMemberId = null;

    await record('NODE-16:ended-state-replay-cycles', async () => {
      const roomId = 'REPLAY1';
      const roomCode = '702';
      const createRes = await createRoom(baseUrl, roomId, {
        name: 'ReplayHost',
        roomCode,
        accountId: 'acc-replay-host'
      });
      assert.equal(createRes.status, 201);

      const joinRes = await joinRoom(baseUrl, roomCode, {
        name: 'ReplayHost',
        accountId: 'acc-replay-host'
      });
      assert.equal(joinRes.status, 200);
      hostMemberId = joinRes.json.session.memberId;

      const sourceRes = await sendCommand(baseUrl, roomId, hostMemberId, {
        type: 'source',
        input: YOUTUBE_FIXTURES.valid[0].input
      });
      assert.equal(sourceRes.status, 200);

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const endRes = await sendCommand(baseUrl, roomId, hostMemberId, {
          type: 'pause',
          position: 10,
          ended: true
        });
        assert.equal(endRes.status, 200, `end cycle ${cycle} accepted`);
        assert.equal(endRes.json.state.playback.paused, true, `cycle ${cycle} is paused`);
        assert.equal(endRes.json.state.playback.ended, true, `cycle ${cycle} is explicitly ended`);
        assert.equal(endRes.json.state.playback.position, 10, `cycle ${cycle} stays at end`);

        const replayRes = await sendCommand(baseUrl, roomId, hostMemberId, {
          type: 'play',
          position: 10
        });
        assert.equal(replayRes.status, 200, `replay cycle ${cycle} accepted`);
        assert.equal(replayRes.json.state.playback.paused, false, `cycle ${cycle} resumes`);
        assert.equal(replayRes.json.state.playback.ended, false, `cycle ${cycle} clears ended state`);
        assert.ok(replayRes.json.state.playback.position < 0.1, `cycle ${cycle} restarts at zero`);
      }

      const finalState = await request(baseUrl, `/${''}`);
      assert.ok(finalState, 'server remains reachable after replay cycles');
    });
  } finally {
    if (server.stop) await server.stop();
    else if (server.close) await server.close();
  }

  return results;
}
