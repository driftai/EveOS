import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { parseByteRange, streamMedia } from '../media-range.js';

assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
assert.deepEqual(parseByteRange('bytes=10-', 100), { start: 10, end: 99 });
assert.deepEqual(parseByteRange('bytes=0-500', 100), { start: 0, end: 99 });
for (const bad of ['bytes=-0', 'bytes=100-', 'bytes=2-1', 'bytes=0-1,4-5', 'bytes=-', 'bytes=9007199254740999-']) {
  assert.equal(parseByteRange(bad, 100), null, bad);
}
const file = new URL('../public/media/voxelvision-demo.mp4', import.meta.url);
const size = fs.statSync(file).size;
const server = http.createServer((req, res) => {
  const range = parseByteRange(req.headers.range || 'bytes=0-', size);
  if (!range) { res.writeHead(416); res.end(); return; }
  res.writeHead(206, { 'Content-Length': range.end - range.start + 1 });
  streamMedia(req, res, file, range);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => {
      const req = http.get(url, res => { res.once('data', () => { req.destroy(); resolve(); }); });
      req.on('error', resolve);
    });
    const response = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 1024);
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log('Media range smoke passed: suffix ranges and 25 cancelled-stream/replay cycles.');
