'use strict';
// Electron-free unit tests for the spike's privilege policy and native-session bridge.
// Run: node --test tools/experiments/electron-targeted-capture/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const policy = require('../policy');
const { createBridge, readInstallCredential, MAX_PENDING } = require('../bridge');
const { load, loopbackBridge } = require('../config');
const fs = require('node:fs');
const os = require('node:os');

const page = (name, q = '') => pathToFileURL(path.join(policy.PAGES_DIR, name)).href + q;

test('navigation allow-list uses resolved containment and exact approved pages', () => {
  assert.equal(policy.allowedUrl(page('tone.html', '?hz=440')), true);
  assert.equal(policy.allowedUrl(page('capture.html')), true);
  assert.equal(policy.allowedUrl(page('capture-worklet.js')), false);
  assert.equal(policy.allowedUrl(pathToFileURL(path.join(policy.PAGES_DIR, '..', 'main.js')).href), false);
  assert.equal(policy.allowedUrl('file:///tmp/evil/electron-targeted-capture/pages/tone.html'), false);
  assert.equal(policy.allowedUrl(`${page('x')}/../../../../README.md`), false);
  assert.equal(policy.allowedUrl('https://open.spotify.com/embed/track/1'), true);
  assert.equal(policy.allowedUrl('https://accounts.spotify.com/login?code=1'), true);
  for (const bad of ['http://open.spotify.com/', 'https://open.spotify.com.evil.test/', 'https://evil.test/',
    'https://user:pw@open.spotify.com/', 'https://open.spotify.com:8443/', 'javascript:alert(1)', 'not a url']) {
    assert.equal(policy.allowedUrl(bad), false, bad);
  }
});

test('capture privilege is bound to the exact trusted document', () => {
  assert.equal(policy.isCaptureUrl(policy.CAPTURE_URL), true);
  assert.equal(policy.isCaptureUrl(`${policy.CAPTURE_URL}?x=1`), false);
  assert.equal(policy.isCaptureUrl(`${policy.CAPTURE_URL}#frag`), false);
  assert.equal(policy.isCaptureUrl(page('tone.html')), false);
  assert.equal(policy.isCaptureUrl('https://open.spotify.com/'), false);
});

test('diagnostics redact auth-bearing parameters', () => {
  assert.equal(policy.redact('https://accounts.spotify.com/authorize?code=SECRET&state=S#t=1'),
    'https://accounts.spotify.com/authorize [params redacted]');
  assert.ok(!policy.redact(page('tone.html', '?hz=440')).includes('/workspace'));
});


test('Windows CRLF and Linux LF credential envelope accepted; malformed or short rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-spike-credential-'));
  const file = path.join(root, 'data', 'runtime', 'audioflix-provider-file-auth.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const key = 'k'.repeat(64);
    for (const ending of [';\\n', ';\\r\\n']) {
      fs.writeFileSync(file, 'window.__EveOSProviderFileAuth = ' + JSON.stringify(key) + ending.replace(/\\r/g, '\r').replace(/\\n/g, '\n'));
      assert.equal(readInstallCredential(root), key);
    }
    for (const bad of ['window.__EveOSProviderFileAuth = "short";\\r\\n',
      'window.__EveOSProviderFileAuth = "x"; alert(1);\\r\\n',
      'window.__EveOSProviderFileAuth = 3;\\r\\n']) {
      fs.writeFileSync(file, bad.replace(/\\r/g, '\r').replace(/\\n/g, '\n'));
      assert.throws(() => readInstallCredential(root), /credential is invalid/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('install credential destination must be an explicit loopback HTTP origin', () => {
  assert.equal(loopbackBridge('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(loopbackBridge('http://localhost:8765/'), 'http://localhost:8765');
  for (const bad of ['http://0.0.0.0:3000','http://192.168.0.2:3000','http://evil.example:3000',
    'https://127.0.0.1:3000','http://127.0.0.1:3000/redirect',
    'http://127.0.0.1:3000/?token=foo','http://evil@127.0.0.1:3000',
    'http://127.0.0.1','not-a-url']) {
    assert.throws(() => loopbackBridge(bad), /--bridge/, bad);
    assert.throws(() => load(['.', '--bridge='+bad]), /--bridge/, bad);
  }
});

function harness({ startDelay = 0, chunkDelay = 5, startError = null } = {}) {
  const calls = [], notes = [];
  let inFlightChunks = 0, maxInFlight = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fetchImpl = async (url, init) => {
    const route = url.split('/').pop(), body = JSON.parse(init.body);
    calls.push({ route, body, headers: init.headers, t: calls.length });
    if (route === 'start') {
      await wait(startDelay);
      if (startError) return { status: 409, json: async () => ({ ok: false, message: startError }) };
      return { status: 200, json: async () => ({ ok: true, sessionId: `electron:${calls.length}`, captureToken: 'tok',
        lane: body.lane, deviceId: body.deviceId }) };
    }
    if (route === 'chunk') {
      inFlightChunks += 1; maxInFlight = Math.max(maxInFlight, inFlightChunks);
      await wait(chunkDelay); inFlightChunks -= 1;
      return { status: 200, json: async () => ({ ok: true, dropped: 0, underruns: 0, backlogFrames: 0 }) };
    }
    return { status: 200, json: async () => ({ ok: true, chunks: 0, nonzeroChunks: 0 }) };
  };
  const cfg = { bridge: 'http://127.0.0.1:3000', deviceId: 'sd:7', source: 'tone', eveosRoot: '/x' };
  const bridge = createBridge({ cfg, note: (type, d) => notes.push({ type, ...d }), fetchImpl, readKey: () => 'INSTALL-KEY' });
  return { bridge, calls, notes, maxInFlight: () => maxInFlight, wait };
}
const chunk = (i) => ({ audio: Buffer.from(`pcm-${i}`).toString('base64'), sampleRate: 48000, gain: 1 });

test('chunks are ordered, sequential and bounded; the lane and owner generation ride every request', async () => {
  const h = harness({ chunkDelay: 20 });
  await h.bridge.begin('cap-1');
  for (let i = 0; i < 10; i += 1) h.bridge.push('cap-1', chunk(i));
  await h.wait(250);
  const sent = h.calls.filter((c) => c.route === 'chunk');
  assert.equal(h.maxInFlight(), 1, 'more than one chunk in flight');
  assert.equal(sent.length, 1 + MAX_PENDING);
  const order = sent.map((c) => Number(Buffer.from(c.body.audio, 'base64').toString().split('-')[1]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'chunks reordered');
  assert.deepEqual(order.slice(1), [6, 7, 8, 9], 'oldest pending chunks were not the ones dropped');
  for (const c of sent) assert.deepEqual([c.body.lane, c.body.generation, c.body.ownerId], ['electron-capture', 1, h.bridge.ownerId]);
  assert.equal(h.bridge.totals().stale, 10 - 1 - MAX_PENDING);
  const start = h.calls.find((c) => c.route === 'start');
  assert.equal(start.headers['X-EveOS-Provider-File-Auth'], 'INSTALL-KEY');
  assert.ok(sent.every((c) => !('X-EveOS-Provider-File-Auth' in c.headers)), 'install key sent beyond start');
  assert.ok(!JSON.stringify(h.notes).includes('INSTALL-KEY') && !JSON.stringify(h.notes).includes('tok'));
  await h.bridge.end('test');
});

test('Stop retires the generation: no chunk after stop, exactly one stop, late pushes refused', async () => {
  const h = harness({ chunkDelay: 30 });
  await h.bridge.begin('cap-1');
  for (let i = 0; i < 4; i += 1) h.bridge.push('cap-1', chunk(i));
  await h.wait(10);                                   // one chunk is in flight right now
  const ending = h.bridge.end('capture-stopped', 'cap-1');
  h.bridge.push('cap-1', chunk(99));                  // the in-flight race Vera flagged
  await ending;
  h.bridge.push('cap-1', chunk(100));
  await h.wait(80);
  const stopAt = h.calls.findIndex((c) => c.route === 'stop');
  assert.ok(stopAt > 0);
  assert.equal(h.calls.filter((c) => c.route === 'stop').length, 1);
  assert.equal(h.calls.slice(stopAt).filter((c) => c.route === 'chunk').length, 0, 'PCM resurrected after stop');
  assert.equal(h.calls.filter((c) => c.route === 'chunk').length, 1, 'queued chunks were not discarded on stop');
  assert.ok(h.bridge.totals().retired >= 2);
});

test('a new capture is a new generation; a mismatched capture id never feeds it', async () => {
  const h = harness();
  await h.bridge.begin('cap-1');
  await h.bridge.begin('cap-2');                       // implicit end of cap-1
  h.bridge.push('cap-1', chunk(1));
  h.bridge.push('cap-2', chunk(2));
  await h.wait(40);
  const starts = h.calls.filter((c) => c.route === 'start').map((c) => c.body.generation);
  assert.deepEqual(starts, [1, 2]);
  const chunks = h.calls.filter((c) => c.route === 'chunk');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].body.generation, 2);
  assert.equal(h.calls.filter((c) => c.route === 'stop')[0].body.generation, 1);
  await h.bridge.end('test');
});

test('Stop while the session is still starting stops it once it exists, and sends no PCM', async () => {
  const h = harness({ startDelay: 40 });
  const starting = h.bridge.begin('cap-1');
  await h.wait(10);                                    // start request is in flight
  h.bridge.push('cap-1', chunk(1));
  await h.bridge.end('capture-stopped', 'cap-1');
  await starting; await h.wait(20);
  assert.equal(h.calls.filter((c) => c.route === 'chunk').length, 0);
  assert.equal(h.calls.filter((c) => c.route === 'stop').length, 1);

  const quick = harness({ startDelay: 40 });           // Stop before Start was even sent: no session at all
  const s2 = quick.bridge.begin('cap-1');
  await quick.bridge.end('capture-stopped', 'cap-1');
  await s2;
  assert.equal(quick.calls.length, 0);
});

test('a lane owned by another host is reported, not seized, and nothing is forwarded', async () => {
  const h = harness({ startError: 'Another provider capture session already owns the capture lane.' });
  await h.bridge.begin('cap-1');
  h.bridge.push('cap-1', chunk(1));
  await h.wait(20);
  assert.ok(h.notes.some((n) => n.type === 'bridge-start-failed' && /already owns/.test(n.message)));
  assert.equal(h.calls.filter((c) => c.route !== 'start').length, 0);
  await h.bridge.end('test');
  assert.equal(h.calls.filter((c) => c.route === 'stop').length, 0);
});

test('capture-only runs (no device id) never touch the native bridge', async () => {
  const h = harness();
  const b = createBridge({ cfg: { bridge: 'x', deviceId: '' }, note: () => {}, fetchImpl: async () => { throw new Error('called'); } });
  await b.begin('cap'); b.push('cap', chunk(1)); await b.end('x');
  assert.equal(b.totals().sent, 0);
  void h;
});
