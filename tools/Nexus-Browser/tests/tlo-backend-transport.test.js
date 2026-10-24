'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { AUTH_HEADER, canonical, createTloBackendTransport } = require('../local-targets/tlo-backend-transport');

const SECRET = 's'.repeat(32);
const OWNER = { kind: 'backend', id: 'nexus-backend-owner-0001', generation: 2 };
const BINDING = { scopeId: 'default', owner: OWNER, requestId: 'dex-turn-transport-0001',
  roomId: 'room-transport-0001', sourceMessageId: 'msg-source-transport-0001',
  dispatchId: 'tlo-dispatch-transport-0001' };

function sse(text) {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

test('transport signs exact dispatch identity for the dedicated loopback endpoint', async () => {
  let request;
  const transport = createTloBackendTransport({ baseUrl: 'http://127.0.0.1:8765',
    secret: SECRET, serverSessionId: 'nexus-session-0001', owner: OWNER,
    now: () => 1700000000000, nonce: () => 'nonce-transport-0001',
    async fetchImpl(url, options) {
      request = { url, options };
      return { ok: true, headers: { get() { return null; } }, body: sse('answer') };
    } });
  const result = await transport.streamChat({ scopeId: 'default', requestId: BINDING.requestId,
    message: 'hello', history: [{ role: 'user', content: 'prior' }],
    dispatchBinding: BINDING });
  assert.equal(result.text, 'answer');
  assert.match(request.url, /\/backend\/chat\/stream$/);
  const body = JSON.parse(request.options.body);
  const signature = createHmac('sha256', SECRET).update(canonical(body.backendAuth)).digest('hex');
  assert.equal(request.options.headers[AUTH_HEADER], signature);
  assert.equal(body.backendAuth.dispatchId, BINDING.dispatchId);
});

test('transport rejects non-loopback configuration and stale generation before fetch', async () => {
  assert.throws(() => createTloBackendTransport({ baseUrl: 'https://example.com', secret: SECRET,
    serverSessionId: 'nexus-session-0001', owner: OWNER }), TypeError);
  let calls = 0;
  const transport = createTloBackendTransport({ baseUrl: 'http://localhost:8765', secret: SECRET,
    serverSessionId: 'nexus-session-0001', owner: OWNER,
    fetchImpl: async () => { calls += 1; } });
  await assert.rejects(transport.streamChat({ scopeId: 'default', requestId: BINDING.requestId,
    message: 'hello', history: [], dispatchBinding: { ...BINDING,
      owner: { ...OWNER, generation: 1 } } }), { code: 'TLO_BACKEND_TRANSPORT_BINDING_INVALID' });
  assert.equal(calls, 0);
});
