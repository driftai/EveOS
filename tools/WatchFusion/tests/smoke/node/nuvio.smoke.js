import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server-harness.js';
import { request } from '../helpers/http-client.js';
import {
  discoverBackend,
  hardenNuvioYoutubeProxyHtml,
  parsePropertiesFile
} from '../../../src/server/nuvio-config.js';
import { rewriteM3u8 } from '../../../src/server/media-routes.js';

const PORT = 19187;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runNuvioSmokes() {
  const results = [];
  const record = (id, fn) => async () => {
    try {
      await fn();
      results.push({ id, status: 'PASS' });
    } catch (err) {
      results.push({ id, status: 'FAIL', error: err.message });
    }
  };

  // Discovery must never turn a configured private address into a server-side fetch.
  await record('NUV-00:backend-discovery-ssrf-rejection', async () => {
    assert.deepEqual(await discoverBackend('http://127.0.0.1:54321'), {});
    assert.deepEqual(await discoverBackend('http://169.254.169.254'), {});
  })();

  await record('NUV-00A:standalone-config-and-trailer-parity', async () => {
    const envPath = path.join(__dirname, '..', 'fixtures', 'nuvio.env.js');
    assert.equal(parsePropertiesFile(envPath).SUPPORT_URL, 'https://nuvio.tv/support');
    assert.equal(parsePropertiesFile(envPath).SIMKL_APP_NAME, 'Nuvio');

    const hardened = hardenNuvioYoutubeProxyHtml(`
      var pageOrigin = String((location && location.origin) || "").trim();
      var widgetReferrer = pageOriginIsHttp ? location.href : "https://www.youtube.com";
      var autoplay = params.autoplay !== "0";
      if (autoplay) { event.target.playVideo(); }
    `);
    assert.match(hardened, /var autoplay = false/);
    assert.doesNotMatch(hardened, /event\.target\.playVideo/);
  })();

  await record('NUV-00B:embedded-toolbar-contract', async () => {
    const toolRoot = path.join(__dirname, '..', '..', '..');
    const html = fs.readFileSync(path.join(toolRoot, 'public', 'index.html'), 'utf8');
    const toolbarLayout = fs.readFileSync(path.join(toolRoot, 'public', 'client', 'nuvio-embedded-toolbar.js'), 'utf8');
    const staticFiles = fs.readFileSync(path.join(toolRoot, 'src', 'server', 'static-files.js'), 'utf8');

    for (const id of ['nuvioToolbar', 'nuvioBackBtn', 'nuvioHomeBtn', 'nuvioReloadBtn', 'nuvioFullBtn', 'nuvioCloseBtn']) {
      assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
    }
    assert.ok(staticFiles.includes("'client/nuvio-embedded-toolbar.js'"));
    assert.match(toolbarLayout, /html\.eveos-embedded \.nuvio-toolbar/);
    assert.match(toolbarLayout, /z-index:\s*70/);
    assert.match(toolbarLayout, /min-height:\s*38px/);
    assert.match(toolbarLayout, /flex-wrap:\s*nowrap/);
    assert.match(toolbarLayout, /display:\s*grid\s*!important/);
    assert.match(toolbarLayout, /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto\s*!important/);
  })();

  await record('NUV-00C:hls-child-resource-rewrite', async () => {
    const referer = 'https://catalog.example/watch/episode-1';
    const rewritten = rewriteM3u8(
      [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio/en.m3u8"',
        'video/segment-001.ts'
      ].join('\n'),
      'https://cdn.example/media/master.m3u8',
      referer
    );

    for (const url of [
      'https://cdn.example/media/keys/key.bin',
      'https://cdn.example/media/init.mp4',
      'https://cdn.example/media/audio/en.m3u8',
      'https://cdn.example/media/video/segment-001.ts'
    ]) {
      assert.ok(rewritten.includes('/api/media/stream?url=' + encodeURIComponent(url)));
    }
    assert.ok(rewritten.includes('&referer=' + encodeURIComponent(referer)));
  })();

  const server = await startServer({ port: PORT, host: '127.0.0.1' });
  const baseUrl = server.baseUrl;

  try {
    // 1. Entry endpoint
    await record('NUV-01:entry-endpoint', async () => {
      const res1 = await request(baseUrl, '/__nuvio__/entry');
      assert.equal(res1.status, 200);
      assert.ok(res1.json?.ok !== undefined);

      const res2 = await request(baseUrl, '/__wrapper__/nuvio-entry');
      assert.equal(res2.status, 200);

      if (res1.json?.ok) {
        const legacyPath = await request(baseUrl, '/nuvio');
        assert.equal(legacyPath.status, 302);
        assert.equal(legacyPath.headers.location, '/nuvio/dist/index.html');
      }
    })();

    // 2. Env script generation & secret redaction
    await record('NUV-02:env-script-secret-redaction', async () => {
      const res = await request(baseUrl, '/__nuvio__/env.js');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('window.__NUVIO_ENV__'));
      assert.ok(res.body.includes('window.fetch'));
      assert.ok(!res.body.includes('TRAKT_CLIENT_SECRET'));
      assert.ok(!res.body.includes('TMDB_API_KEY'));
      assert.ok(res.body.includes('/__nuvio__/youtube-proxy.html'));
      assert.ok(res.body.includes('trailerAutoplay = false'));

      const mediaBranch = res.body.indexOf('if (mediaPathRe.test(mediaCandidate)');
      const addonBranch = res.body.indexOf('if (addonPathRe.test(parsed.pathname))');
      assert.ok(mediaBranch >= 0 && addonBranch > mediaBranch, 'media URLs must be classified before generic addon /stream/ paths');
      assert.ok(res.body.includes('HTMLMediaElement'));
      assert.ok(res.body.includes('__watchFusionNuvioMediaSrcPatched'));
      assert.ok(res.body.includes('mp4|m4v|mov|mkv|webm'));
    })();

    await record('NUV-02A:user-initiated-youtube-proxy', async () => {
      const res = await request(baseUrl, '/__nuvio__/youtube-proxy.html');
      if (res.status === 404) return;
      assert.equal(res.status, 200);
      assert.match(res.body, /var autoplay = false/);
      assert.doesNotMatch(res.body, /if \(autoplay\) \{\s*event\.target\.playVideo/);
    })();

    // 3. Diagnostics endpoint and filesystem path redaction
    await record('NUV-03:diagnostics-path-redaction', async () => {
      const res = await request(baseUrl, '/__nuvio__/diagnostics');
      assert.equal(res.status, 200);
      assert.ok(res.json?.backend);
      assert.equal(res.json?.root, undefined);
      assert.equal(res.json?.dist, undefined);
      assert.equal(res.json?.path, undefined);
    })();

    // 4. Addon Proxy SSRF & Security Validations
    await record('NUV-04:addon-proxy-ssrf-rejection', async () => {
      // Loopback
      const loopback = await request(baseUrl, '/__nuvio__/addon-proxy?url=' + encodeURIComponent('https://127.0.0.1/manifest.json'));
      assert.equal(loopback.status, 403);

      // Non-HTTPS
      const httpTarget = await request(baseUrl, '/__nuvio__/addon-proxy?url=' + encodeURIComponent('http://example.com/manifest.json'));
      assert.equal(httpTarget.status, 403);

      // Non-Stremio path
      const nonStremio = await request(baseUrl, '/__nuvio__/addon-proxy?url=' + encodeURIComponent('https://example.com/private/keys.json'));
      assert.equal(nonStremio.status, 403);
    })();

    // 5. Addon Proxy Live Cinemeta Fetch
    await record('NUV-05:addon-proxy-live-cinemeta', async () => {
      const target = 'https://v3-cinemeta.strem.io/manifest.json';
      const res = await request(baseUrl, '/__nuvio__/addon-proxy?url=' + encodeURIComponent(target));
      assert.equal(res.status, 200);
      assert.equal(res.json?.id, 'com.linvo.cinemeta');
    })();

    // 6. Addon Proxy Movie Metadata Resolution
    await record('NUV-06:addon-proxy-movie-metadata', async () => {
      const target = 'https://v3-cinemeta.strem.io/meta/movie/tt0111161.json';
      const res = await request(baseUrl, '/__nuvio__/addon-proxy?url=' + encodeURIComponent(target));
      assert.equal(res.status, 200);
      assert.equal(res.json?.meta?.moviedb_id, 278);
    })();

    // 7. Addon Proxy Error Resilience (prevents ERR_HTTP_HEADERS_SENT)
    await record('NUV-07:addon-proxy-error-resilience', async () => {
      // Connect to unreachable public host on valid stremio path
      const target = 'https://192.0.2.1/manifest.json';
      const res = await request(baseUrl, '/__nuvio__/addon-proxy?url=' + encodeURIComponent(target));
      assert.ok([403, 502, 504].includes(res.status));
    })();
  } finally {
    await server.stop();
  }

  return results;
}
