import assert from 'node:assert/strict';
import { listMediaProviders, findMediaProvider } from '../../../src/server/media-provider-registry.js';
import { startServer } from '../helpers/server-harness.js';
import { createRoom, joinRoom, request } from '../helpers/http-client.js';

const PORT = 19189;

export async function runUnifiedMediaProviderSmokes() {
  const results = [];
  const record = (id, fn) => async () => {
    try {
      await fn();
      results.push({ id, status: 'PASS' });
    } catch (err) {
      results.push({ id, status: 'FAIL', error: err.message });
    }
  };

  // 1. Registry contains all 4 unified providers
  await record('PROV-01:unified-provider-registry-listing', async () => {
    const list = listMediaProviders();
    assert.ok(list.includes('direct-media'));
    assert.ok(list.includes('youtube'));
    assert.ok(list.includes('nuvio'));
    assert.ok(list.includes('browser-page'));
  })();

  // 2. Direct media resolution
  await record('PROV-02:direct-media-resolution', async () => {
    const provider = findMediaProvider('https://example.com/stream/master.m3u8');
    assert.equal(provider?.id, 'direct-media');
    const res = await provider.resolve('https://example.com/stream/master.m3u8');
    assert.equal(res.ok, true);
    assert.equal(res.results[0].type, 'hls');
  })();

  // 3. YouTube provider resolution
  await record('PROV-03:youtube-resolution', async () => {
    const provider = findMediaProvider('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(provider?.id, 'youtube');
    const res = await provider.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(res.ok, true);
    assert.equal(res.results[0].videoId, 'dQw4w9WgXcQ');
    assert.equal(res.results[0].type, 'youtube');
  })();

  // 4. Nuvio provider resolution
  await record('PROV-04:nuvio-provider-resolution', async () => {
    const provider = findMediaProvider('nuvio://cinemeta/movie/tt0111161');
    assert.equal(provider?.id, 'nuvio');
    const res = await provider.resolve('nuvio://cinemeta/movie/tt0111161');
    assert.equal(res.ok, true);
    assert.equal(res.results[0].type, 'nuvio');
    assert.equal(res.results[0].entryUrl, '/nuvio/dist/index.html');
  })();

  const server = await startServer({ port: PORT, host: '127.0.0.1' });
  const baseUrl = server.baseUrl;

  try {
    // 5. Room media state accepts Nuvio source contract seamlessly
    await record('PROV-05:room-accepts-nuvio-source-contract', async () => {
      const created = await createRoom(baseUrl, 'PROVROOM1', { name: 'ProvHost', roomCode: '911', accountId: 'host-acc-911' });
      assert.equal(created.status, 201);
      const host = await joinRoom(baseUrl, '911', { name: 'ProvHost', accountId: 'host-acc-911' });
      assert.equal(host.status, 200);
      const memberId = host.json.session.memberId;

      const res = await request(baseUrl, '/api/rooms/PROVROOM1/media-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-member-id': memberId },
        body: JSON.stringify({
          originalUrl: 'nuvio://cinemeta/movie/tt0111161',
          media: {
            kind: 'nuvio',
            type: 'nuvio',
            url: 'nuvio://cinemeta/movie/tt0111161',
            title: 'The Shawshank Redemption',
            metadata: { imdb: 'tt0111161', tmdb: 278 }
          }
        })
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.state.source.kind, 'nuvio');
      assert.equal(res.json.state.source.type, 'nuvio');
      assert.equal(res.json.state.source.title, 'The Shawshank Redemption');
      assert.equal(res.json.state.source.entryUrl, '/nuvio/dist/index.html');
    })();

    // 6. Nuvio failure isolation: non-Nuvio providers operate normally
    await record('PROV-06:provider-fault-isolation', async () => {
      const host = await joinRoom(baseUrl, '911', { name: 'ProvHost', accountId: 'host-acc-911' });
      assert.equal(host.status, 200);
      const memberId = host.json.session.memberId;

      // Switch to YouTube without errors
      const ytRes = await request(baseUrl, '/api/rooms/PROVROOM1/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-member-id': memberId },
        body: JSON.stringify({ type: 'source', input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
      });
      assert.equal(ytRes.status, 200);
      assert.equal(ytRes.json.state.source.type, 'youtube');
      assert.equal(ytRes.json.state.source.videoId, 'dQw4w9WgXcQ');
    })();
  } finally {
    await server.stop();
  }

  return results;
}
