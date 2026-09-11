import assert from 'node:assert/strict';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { YOUTUBE_FIXTURES } from '../fixtures/youtube.js';
import { startServer } from '../helpers/server-harness.js';
import { createRoom, joinRoom, sendCommand } from '../helpers/http-client.js';

const PORT = 19385;

export async function runYouTubeSmoke() {
  const results = [];
  const record = (id, fn) => async () => {
    try {
      const res = await fn();
      if (res && res.skip) {
        results.push({ id, status: 'SKIP', reason: res.reason });
      } else {
        results.push({ id, status: 'PASS' });
      }
    } catch (err) {
      results.push({ id, status: 'FAIL', error: err.message });
    }
  };

  // Deterministic URL tests (never require internet)
  await record('INT-YT-01:deterministic-url-parsing', async () => {
    const server = await startServer({ port: PORT, host: '127.0.0.1' });
    try {
      const roomId = 'YT_TEST';
      await createRoom(server.baseUrl, roomId, { name: 'HostAlice' });
      const join = await joinRoom(server.baseUrl, roomId, { name: 'HostAlice' });
      const hostId = join.json?.session?.memberId;

      for (const item of YOUTUBE_FIXTURES.valid) {
        const cmdRes = await sendCommand(server.baseUrl, roomId, hostId, {
          type: 'source',
          input: item.input
        });
        assert.equal(cmdRes.status, 200, `Valid URL failed: ${item.type} (${item.input})`);
        assert.equal(cmdRes.json?.state?.source?.videoId, item.expectedId, `Extracted ID mismatch for ${item.type}`);
      }

      for (const invalidInput of YOUTUBE_FIXTURES.invalid) {
        const cmdRes = await sendCommand(server.baseUrl, roomId, hostId, {
          type: 'source',
          input: invalidInput
        });
        assert.equal(cmdRes.status, 400, `Invalid URL should return 400: "${invalidInput}"`);
      }
    } finally {
      await server.stop();
    }
  })();

  // Optional live YouTube test (requires internet + RUN_LIVE_YOUTUBE=1)
  await record('INT-YT-02:live-youtube-oembed-reachability', async () => {
    if (process.env.RUN_LIVE_YOUTUBE !== '1') {
      return { skip: true, reason: 'Live YouTube check is opt-in (set RUN_LIVE_YOUTUBE=1)' };
    }

    return new Promise((resolve, reject) => {
      const testVideo = 'dQw4w9WgXcQ';
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${testVideo}&format=json`;
      const req = https.get(oembedUrl, { timeout: 4000 }, res => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          resolve({ skip: true, reason: `YouTube oembed returned status ${res.statusCode}` });
        }
      });
      req.on('error', err => {
        resolve({ skip: true, reason: `Could not reach YouTube: ${err.message}` });
      });
    });
  })();

  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runYouTubeSmoke().then(results => {
    for (const r of results) {
      console.log(`[${r.status}] ${r.id}${r.reason ? ` (${r.reason})` : ''}${r.error ? `: ${r.error}` : ''}`);
    }
  });
}
