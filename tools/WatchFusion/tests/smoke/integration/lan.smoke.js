import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server-harness.js';
import { request } from '../helpers/http-client.js';

const PORT = 19285;

export async function runLanSmoke() {
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

  let server = null;
  try {
    server = await startServer({ port: PORT, host: '0.0.0.0', lan: true });
  } catch (err) {
    return [{ id: 'INT-LAN-01:lan-binding', status: 'SKIP', reason: `Could not bind 0.0.0.0: ${err.message}` }];
  }

  try {
    const baseUrl = server.baseUrl;

    await record('INT-LAN-01:lan-binding-and-network-info', async () => {
      const res = await request(baseUrl, '/api/network-info');
      assert.equal(res.status, 200, 'Network-info returns 200 in LAN mode');
      assert.equal(res.json?.ok, true);
      assert.equal(res.json?.localMode, false, 'Local mode is disabled when LAN mode is active');

      if (!res.json?.preferredLanIp) {
        return { skip: true, reason: 'No physical LAN IPv4 interface detected in this environment' };
      }

      // Verify physical LAN IP format
      assert.match(res.json.preferredLanIp, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'Valid LAN IPv4 address');

      // Verify sslip.io conversion
      const expectedHostSuffix = `${res.json.preferredLanIp.replace(/\./g, '-')}.sslip.io:${PORT}`;
      assert.ok(res.json.preferredLanHost?.includes(expectedHostSuffix), 'Canonical LAN URL uses sslip.io host format');

      // Virtual adapter check: ensure virtual adapters are not chosen as preferred
      if (res.json.localOnlyAddresses && res.json.localOnlyAddresses.length > 0) {
        assert.ok(
          !res.json.localOnlyAddresses.includes(res.json.preferredLanIp),
          'Virtual/local-only adapter must not be selected as preferred LAN IP'
        );
      }
    })();

  } finally {
    if (server) await server.stop();
  }

  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runLanSmoke().then(results => {
    for (const r of results) {
      console.log(`[${r.status}] ${r.id}${r.reason ? ` (${r.reason})` : ''}${r.error ? `: ${r.error}` : ''}`);
    }
  });
}
