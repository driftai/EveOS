import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.js';
import { request } from '../helpers/http-client.js';

const PORT = 19193;

export async function runNuvioLiveSmoke() {
  const results = [];
  const record = async (id, fn) => {
    try { await fn(); results.push({ id, status: 'PASS' }); }
    catch (error) { results.push({ id, status: 'FAIL', error: error.message }); }
  };
  const server = await startServer({ port: PORT, host: '127.0.0.1' });
  try {
    await record('INT-NUVIO-01:addon-proxy-live-cinemeta', async () => {
      const target = 'https://v3-cinemeta.strem.io/manifest.json';
      const response = await request(server.baseUrl, '/__nuvio__/addon-proxy?url=' + encodeURIComponent(target));
      assert.equal(response.status, 200);
      assert.equal(response.json?.id, 'com.linvo.cinemeta');
    });
    await record('INT-NUVIO-02:addon-proxy-movie-metadata', async () => {
      const target = 'https://v3-cinemeta.strem.io/meta/movie/tt0111161.json';
      const response = await request(server.baseUrl, '/__nuvio__/addon-proxy?url=' + encodeURIComponent(target));
      assert.equal(response.status, 200);
      assert.equal(response.json?.meta?.moviedb_id, 278);
    });
  } finally {
    await server.stop();
  }
  return results;
}
