import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server-harness.js';
import { createRoom, joinRoom, request } from '../helpers/http-client.js';
import { PROJECT_ROOT, VOXELVISION_ROOT } from '../../../src/server/config.js';

const PORT = 19189;

export async function runVoxelVisionSmokes() {
  const results = [];
  const record = async (id, fn) => {
    try {
      await fn();
      results.push({ id, status: 'PASS' });
    } catch (error) {
      results.push({ id, status: 'FAIL', error: error.message });
    }
  };

  const server = await startServer({ port: PORT, host: '127.0.0.1' });
  const baseUrl = server.baseUrl;
  const originHeaders = { origin: baseUrl };

  await record('VOX-00:live-source-is-original-independent', async () => {
    assert.equal(VOXELVISION_ROOT, path.join(PROJECT_ROOT, 'voxelvision'));
    assert.equal(fs.existsSync(path.join(VOXELVISION_ROOT, 'public', 'index.html')), true);
    const routes = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'server', 'voxelvision-routes.js'), 'utf8');
    assert.doesNotMatch(routes, /original[\\/]VoxelVision/i);
  });

  try {
    await record('VOX-01:entry-and-embedded-shell', async () => {
      const entry = await request(baseUrl, '/__voxelvision__/entry');
      assert.equal(entry.status, 200);
      assert.equal(entry.json?.ok, true);
      assert.equal(entry.json?.path, '/voxelvision/');

      const shell = await request(baseUrl, '/voxelvision/');
      assert.equal(shell.status, 200);
      assert.match(shell.body, /VOXELVISION/);
      assert.match(shell.headers['content-security-policy'] || '', /frame-ancestors 'self'/);
      assert.equal(shell.headers['x-frame-options'], 'SAMEORIGIN');
    });

    await record('VOX-02:mounted-assets-and-byte-ranges', async () => {
      const runtimePaths = await request(baseUrl, '/voxelvision/js/runtime-paths.js');
      assert.equal(runtimePaths.status, 200);
      assert.match(runtimePaths.body, /MOUNT_PREFIX/);

      const range = await request(baseUrl, '/voxelvision/media/voxelvision-demo.mp4', {
        headers: { range: 'bytes=0-31' }
      });
      assert.equal(range.status, 206);
      assert.match(range.headers['content-range'] || '', /^bytes 0-31\/\d+$/);
      assert.equal(range.headers['content-length'], '32');

      const traversal = await request(baseUrl, '/voxelvision/%2e%2e/%2e%2e/server.js');
      assert.notEqual(traversal.status, 200);
    });

    await record('VOX-03:same-origin-api-boundary', async () => {
      const hardware = await request(baseUrl, '/voxelvision/api/hardware', { headers: originHeaders });
      assert.equal(hardware.status, 200);
      assert.equal(typeof hardware.json?.logicalCores, 'number');

      const rejected = await request(baseUrl, '/voxelvision/api/status', {
        headers: { origin: 'https://untrusted.example' }
      });
      assert.equal(rejected.status, 403);

      const invalidImport = await request(baseUrl, '/voxelvision/api/youtube/import', {
        method: 'POST',
        headers: { ...originHeaders, 'content-type': 'application/json' },
        body: { url: 'https://example.com/not-youtube' }
      });
      assert.equal(invalidImport.status, 400);
    });

    await record('VOX-04:room-source-promotion', async () => {
      const roomId = 'VOXEL1';
      const created = await createRoom(baseUrl, roomId, { name: 'VoxelHost' });
      assert.equal(created.status, 201);
      const joined = await joinRoom(baseUrl, roomId, { name: 'VoxelHost', accountId: 'voxel-host-account' });
      const memberId = joined.json?.session?.memberId;
      assert.ok(memberId);

      const promoted = await request(baseUrl, `/api/rooms/${roomId}/media-source`, {
        method: 'POST',
        headers: { 'x-member-id': memberId },
        body: { media: { kind: 'voxelvision', title: 'VoxelVision' } }
      });
      assert.equal(promoted.status, 200);
      assert.equal(promoted.json?.state?.source?.kind, 'voxelvision');
      assert.equal(promoted.json?.state?.source?.entryUrl, '/voxelvision/');
    });
  } finally {
    await server.stop();
  }

  return results;
}
