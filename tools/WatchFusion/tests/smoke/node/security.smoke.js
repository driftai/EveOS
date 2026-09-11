import assert from 'node:assert/strict';
import { publicState, createRoom, joinMember, appendChat } from '../../../src/server/room-store.js';
import { handleSystemRoute } from '../../../src/server/system-routes.js';
import { handleSetupRoute } from '../../../src/server/setup-routes.js';
import { isContainedPath } from '../../../src/server/static-files.js';
import { assertPublicHttpUrl } from '../../../src/server/public-url.js';
import path from 'node:path';

function mockResponse() {
  return {
    statusCode: null,
    body: '',
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(body = '') { this.body += body; }
  };
}

export async function runSecuritySmokes() {
  const results = [];
  const check = async (id, fn) => {
    try { await fn(); results.push({ id, status: 'PASS' }); }
    catch (error) { results.push({ id, status: 'FAIL', error: error.message }); }
  };

  await check('SEC-NETWORK-INFO-TUNNEL-DENY', () => {
    const res1 = mockResponse();
    const handled1 = handleSystemRoute({ method: 'GET', url: '/api/network-info', headers: { host: 'example.trycloudflare.com' } }, res1, ['api', 'network-info']);
    assert.equal(handled1, true);
    assert.equal(res1.statusCode, 403);
    assert.match(res1.body, /local-only/);

    const res2 = mockResponse();
    const handled2 = handleSystemRoute({ method: 'GET', url: '/api/network-info', headers: { host: 'localhost', 'x-forwarded-host': 'tunnel.trycloudflare.com' } }, res2, ['api', 'network-info']);
    assert.equal(handled2, true);
    assert.equal(res2.statusCode, 403);
    assert.match(res2.body, /local-only/);
  });

  await check('SEC-SETUP-INSTALL-REMOTE-DENY', async () => {
    for (const headers of [
      { host: 'example.trycloudflare.com' },
      { host: '127.0.0.1:9085', 'x-forwarded-host': 'example.trycloudflare.com' },
      { host: '127.0.0.1:9085', 'cf-ray': 'test-ray', 'cf-connecting-ip': '203.0.113.8' },
      { host: '127-0-0-1.sslip.io:9085', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }
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

  await check('SEC-NETWORK-INFO-LOCAL-ALLOW', () => {
    const res = mockResponse();
    const handled = handleSystemRoute({ method: 'GET', url: '/api/network-info', headers: { host: '127.0.0.1:9085' } }, res, ['api', 'network-info']);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.localAddress);
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
