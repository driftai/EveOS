import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveMediaPage } from '../../../src/server/media-resolver.js';

const PORT = 19189;

function startFixture() {
  const server = http.createServer((req, res) => {
    if (req.url === '/watch/episode-1') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      return res.end(`<!doctype html><html><head><title>Example Episode</title></head><body>
        <button id="sub">SUB · Kiwi</button>
        <button id="dub">DUB · Arc</button>
        <video controls playsinline src="/media/sub/master.m3u8"></video>
        <track src="/subs/english.vtt" label="English" kind="subtitles">
        <script>
          const video = document.querySelector('video');
          document.querySelector('#sub').onclick = () => video.src = '/media/sub/master.m3u8';
          document.querySelector('#dub').onclick = () => video.src = '/media/dub/master.m3u8';
        </script>
      </body></html>`);
    }
    if (req.url === '/media/sub/master.m3u8' || req.url === '/media/dub/master.m3u8') {
      res.writeHead(200, {'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*'});
      return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-ENDLIST\n');
    }
    if (req.url === '/subs/english.vtt') {
      res.writeHead(200, {'content-type': 'text/vtt'});
      return res.end('WEBVTT\n');
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

export async function runMediaResolverSmokes() {
  const results = [];
  const record = async (id, fn) => {
    try { await fn(); results.push({ id, status: 'PASS' }); }
    catch (error) { results.push({ id, status: 'FAIL', error: error.message }); }
  };
  const server = await startFixture();
  try {
    await record('MEDIA-RESOLVE-01:browser-network-capture', async () => {
      const result = await resolveMediaPage(`http://127.0.0.1:${PORT}/watch/episode-1`, { allowLocal: true, timeoutMs: 8000, maxResults: 8 });
      assert.equal(result.ok, true);
      assert.equal(result.title, 'Example Episode');
      assert.ok(result.results.some(item => item.url.endsWith('/media/sub/master.m3u8')));
      assert.ok(result.results.some(item => item.url.endsWith('/media/dub/master.m3u8')));
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  return results;
}
