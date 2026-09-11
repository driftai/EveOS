import assert from 'node:assert/strict';
import path from 'node:path';
import { publicState, createRoom, joinMember, appendChat } from '../../../src/server/room-store.js';
import { handleSystemRoute } from '../../../src/server/system-routes.js';
import { handleSetupRoute } from '../../../src/server/setup-routes.js';
import { handleNuvioRoute } from '../../../src/server/nuvio-routes.js';
import { handleVoxelVisionRoute } from '../../../src/server/voxelvision-routes.js';
import { applyApiCors } from '../../../src/server/http-utils.js';
import { isContainedPath } from '../../../src/server/static-files.js';
import { assertPublicHttpUrl } from '../../../src/server/public-url.js';

function mockResponse() {
  return {
    statusCode: null,
    body: '',
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(body = '') { this.body += body || ''; }
  };
}

function localRequest(overrides = {}) {
  return {
    method: 'GET',
    url: '/api/network-info',
    headers: { host: '127.0.0.1:9087', origin: 'http://127.0.0.1:9087', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
    headers: {
      host: '127.0.0.1:9087',
      origin: 'http://127.0.0.1:9087',
      'sec-fetch-site': 'same-origin',
      ...(overrides.headers || {})
    },
    socket: overrides.socket || { remoteAddress: '127.0.0.1' }
  };
}

export async function runSecuritySmokes() {
  const results = [];
  const check = async (id, fn) => {
    try { await fn(); results.push({ id, status: 'PASS' }); }
    catch (error) { results.push({ id, status: 'FAIL', error: error.message }); }
  };

  await check('SEC-CORS-TRUSTED-SAME-HOST-ALLOW', () => {
    const res = mockResponse();
    applyApiCors({
      method: 'GET', url: '/api/health',
      headers: { host: '127.0.0.1:9087', origin: 'http://127.0.0.1:8765' }
    }, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:8765');
    assert.equal(res.headers.Vary, 'Origin');
  });

  await check('SEC-CORS-CROSS-SITE-DENY', () => {
    const res = mockResponse();
    applyApiCors({
      method: 'GET', url: '/api/network-info',
      headers: { host: '127.0.0.1:9087', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }
    }, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  });

  await check('SEC-CORS-NULL-ORIGIN-HEALTH-ONLY', () => {
    const health = mockResponse();
    applyApiCors({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:9087', origin: 'null' } }, health);
    assert.equal(health.headers['Access-Control-Allow-Origin'], 'null');

    const diagnostics = mockResponse();
    applyApiCors({ method: 'GET', url: '/api/network-info', headers: { host: '127.0.0.1:9087', origin: 'null' } }, diagnostics);
    assert.equal(diagnostics.headers['Access-Control-Allow-Origin'], undefined);
  });

  await check('SEC-NETWORK-INFO-REMOTE-DENY', () => {
    for (const req of [
      localRequest({ headers: { host: 'example.trycloudflare.com', origin: 'https://example.trycloudflare.com' } }),
      localRequest({ headers: { host: '127.0.0.1:9087', 'x-forwarded-host': 'tunnel.trycloudflare.com' } }),
      localRequest({ headers: { host: '127.0.0.1:9087', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }),
      localRequest({ socket: { remoteAddress: '192.168.1.25' }, headers: { host: '192.168.1.10:9087', origin: 'http://192.168.1.10:9087' } })
    ]) {
      const res = mockResponse();
      const handled = handleSystemRoute(req, res, ['api', 'network-info']);
      assert.equal(handled, true);
      assert.equal(res.statusCode, 403);
      assert.match(res.body, /host-local/);
    }
  });

  await check('SEC-NETWORK-INFO-LOCAL-ALLOW', () => {
    const res = mockResponse();
    const handled = handleSystemRoute(localRequest(), res, ['api', 'network-info']);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.localAddress);
  });

  await check('SEC-SETUP-INSTALL-REMOTE-DENY', async () => {
    for (const headers of [
      { host: 'example.trycloudflare.com', origin: 'https://example.trycloudflare.com' },
      { host: '127.0.0.1:9087', 'x-forwarded-host': 'example.trycloudflare.com' },
      { host: '127.0.0.1:9087', 'cf-ray': 'test-ray', 'cf-connecting-ip': '203.0.113.8' },
      { host: '127-0-0-1.sslip.io:9087', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { host: '127.0.0.1:9087', origin: 'null' }
    ]) {
      const res = mockResponse();
      const req = {
        method: 'POST',
        url: '/api/setup/install',
        headers,
        socket: { remoteAddress: '127.0.0.1' }
      };
      const handled = await handleSetupRoute(req, res, ['api', 'setup', 'install']);
      assert.equal(handled, true);
      assert.equal(res.statusCode, 403, `installer must reject non-local browser context ${JSON.stringify(headers)}`);
      assert.match(res.body, /host-local/);
    }
  });

  await check('SEC-SETUP-DIAGNOSTICS-REMOTE-DENY', async () => {
    const res = mockResponse();
    const req = {
      method: 'GET', url: '/api/setup/status',
      headers: { host: 'room.trycloudflare.com', origin: 'https://room.trycloudflare.com' },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const handled = await handleSetupRoute(req, res, ['api', 'setup', 'status']);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
  });

  await check('SEC-NUVIO-DIAGNOSTICS-REMOTE-DENY', async () => {
    const res = mockResponse();
    const req = {
      method: 'GET', url: '/__nuvio__/diagnostics',
      headers: { host: 'room.trycloudflare.com', origin: 'https://room.trycloudflare.com' },
      socket: { remoteAddress: '127.0.0.1' }
    };
    await handleNuvioRoute(req, res, '/__nuvio__/diagnostics', new URL('https://room.trycloudflare.com/__nuvio__/diagnostics'));
    assert.equal(res.statusCode, 403);
  });

  await check('SEC-VOXEL-HARDWARE-REMOTE-REDACT', async () => {
    const req = {
      method: 'GET', url: '/voxelvision/api/status',
      headers: { host: 'room.trycloudflare.com', origin: 'https://room.trycloudflare.com', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = mockResponse();
    await handleVoxelVisionRoute(req, res, '/voxelvision/api/status');
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.hostLocal, false);
    assert.equal(payload.hardware.redacted, true);
    assert.equal(payload.hardware.cpuModel, null);
    assert.deepEqual(payload.hardware.gpuLabels, []);
    assert.equal(payload.youtube.remoteDisabled, true);
    assert.equal(payload.youtube.provider, null);
  });

  await check('SEC-VOXEL-REMOTE-IMPORT-DENY', async () => {
    const req = {
      method: 'POST', url: '/voxelvision/api/youtube/import',
      headers: {
        host: 'room.trycloudflare.com', origin: 'https://room.trycloudflare.com',
        'sec-fetch-site': 'same-origin', 'content-type': 'application/json'
      },
      socket: { remoteAddress: '127.0.0.1' }
    };
    const res = mockResponse();
    await handleVoxelVisionRoute(req, res, '/voxelvision/api/youtube/import');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Host-local/);
  });

  await check('SEC-PUBLIC-STATE-REDACTION', () => {
    const created = createRoom('SECROOM', null);
    const room = created.room;
    const joined = joinMember(room, { accountId: 'AAAAAAAA', name: 'AliceHost' });
    appendChat(room, room.members.get(joined.session.memberId), 'Secret chat test');
    const state = publicState(room);
    assert.equal(state.ownerAccountId, undefined);
    assert.equal(state.members[0].accountId, undefined);
    assert.equal(state.hostId, state.members[0].id);
    assert.notEqual(state.hostId, joined.session.memberId);
    assert.equal(state.members[0].id, joined.session.publicId);
    assert.equal(state.messages[0].memberId, joined.session.publicId);
    assert.notEqual(state.messages[0].memberId, joined.session.memberId);
  });

  await check('SEC-RESUME-IDENTITY-MISMATCH', () => {
    const created = createRoom('SECMATCH', null);
    const room = created.room;
    const joined = joinMember(room, { accountId: 'BBBBBBBB', name: 'Guest' });
    const replay = joinMember(room, { requestedMemberId: joined.session.memberId, accountId: 'CCCCCCCC', name: 'Attacker' });
    assert.equal(replay.error, 'session identity mismatch');
  });

  await check('SEC-STATIC-CONTAINMENT-VARIANTS', () => {
    const root = path.resolve('public');
    assert.equal(isContainedPath(root, path.resolve(root, 'index.html')), true);
    assert.equal(isContainedPath(root, path.resolve(root, 'client', 'core.js')), true);
    assert.equal(isContainedPath(root, path.resolve(root, '..', 'server.js')), false);
    assert.equal(isContainedPath(root, path.resolve(root, '..', '..', 'Windows', 'System32')), false);
    assert.equal(isContainedPath(root, path.resolve(root, 'client', '..', '..', 'package.json')), false);
  });

  await check('SEC-MEDIA-SSRF-BOUNDARY', async () => {
    const shouldFail = async (url) => {
      let threw = false;
      try { await assertPublicHttpUrl(url); } catch { threw = true; }
      assert.ok(threw, `Expected SSRF rejection for: ${url}`);
    };

    await shouldFail('http://127.0.0.1:8080/stream.mp4');
    await shouldFail('https://localhost/stream.mp4');
    await shouldFail('http://192.168.1.1/video.mp4');
    await shouldFail('http://10.0.0.1/video.mp4');
    await shouldFail('http://172.16.0.1/video.mp4');
    await shouldFail('http://169.254.169.254/latest/meta-data');
    await shouldFail('http://[::1]/video.mp4');
    await shouldFail('http://[fd00::1]/video.mp4');
    await shouldFail('http://[ff00::1]/video.mp4');
    await shouldFail('http://[::ffff:127.0.0.1]/video.mp4');
    await shouldFail('http://user:pass@example.com/video.mp4');
    await shouldFail('ftp://example.com/video.mp4');
    await shouldFail('file:///etc/passwd');
  });

  return results;
}
