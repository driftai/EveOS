'use strict';

const { createHash, createHmac, randomUUID } = require('node:crypto');
const { consumeOpenAiSse } = require('./service-chat-common');

const AUTH_SCHEMA = 'eveos.tlo-backend-transport.v1';
const AUTH_HEADER = 'X-EveOS-TLO-Backend-Authorization';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const SCOPE = /^[a-z][a-z0-9_-]{0,63}$/;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(envelope) {
  return [
    envelope.schema,
    envelope.serverSessionId,
    envelope.scopeId,
    envelope.ownerId,
    String(envelope.ownerGeneration),
    envelope.requestId,
    envelope.roomId,
    envelope.sourceMessageId,
    envelope.dispatchId,
    envelope.nonce,
    String(envelope.issuedAt),
    envelope.messageSha256,
    envelope.historySha256
  ].join('\n');
}
function safeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new TypeError('TLO backend transport requires an explicit loopback HTTP URL.');
  }
  return url.toString().replace(/\/$/, '');
}

function createTloBackendTransport({ baseUrl, secret, serverSessionId, owner,
  fetchImpl = fetch, now = Date.now, nonce = randomUUID } = {}) {
  const endpoint = safeBaseUrl(baseUrl);
  const key = String(secret || '');
  if (key.length < 32 || !ID.test(String(serverSessionId || ''))
      || owner?.kind !== 'backend' || !ID.test(String(owner.id || ''))
      || !Number.isSafeInteger(owner.generation) || owner.generation <= 0
      || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof nonce !== 'function') {
    throw new TypeError('TLO backend transport authentication configuration is invalid.');
  }

  async function streamChat({ scopeId, requestId, message, history, dispatchBinding, onPartial } = {}) {
    if (dispatchBinding?.owner?.kind !== 'backend'
        || dispatchBinding.owner.id !== owner.id
        || dispatchBinding.owner.generation !== owner.generation
        || dispatchBinding.scopeId !== scopeId
        || dispatchBinding.requestId !== requestId) {
      fail('TLO_BACKEND_TRANSPORT_BINDING_INVALID', 'Backend transport lacks the exact dispatch binding.');
    }
    const text = String(message || '').trim();
    const prior = Array.isArray(history) ? history.map((entry) => ({
      role: String(entry?.role || ''), content: String(entry?.content || '').trim()
    })) : [];
    const historyJson = JSON.stringify(prior);
    const envelope = {
      schema: AUTH_SCHEMA,
      serverSessionId: String(serverSessionId),
      scopeId: String(scopeId),
      ownerId: owner.id,
      ownerGeneration: owner.generation,
      requestId: String(requestId),
      roomId: String(dispatchBinding.roomId),
      sourceMessageId: String(dispatchBinding.sourceMessageId),
      dispatchId: String(dispatchBinding.dispatchId),
      nonce: String(nonce()),
      issuedAt: Math.trunc(now()),
      messageSha256: digest(text),
      historySha256: digest(historyJson)
    };
    if (!SCOPE.test(envelope.scopeId)) fail('TLO_BACKEND_TRANSPORT_BINDING_INVALID', 'Invalid scopeId.');
    for (const field of ['serverSessionId','ownerId','requestId','roomId',
      'sourceMessageId','dispatchId','nonce']) {
      if (!ID.test(envelope[field])) fail('TLO_BACKEND_TRANSPORT_BINDING_INVALID', `Invalid ${field}.`);
    }
    const signature = createHmac('sha256', key).update(canonical(envelope)).digest('hex');
    const response = await fetchImpl(`${endpoint}/api/eve-state/modular/tlo/backend/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [AUTH_HEADER]: signature },
      body: JSON.stringify({ requestId, scopeId, message: text, history: prior, backendAuth: envelope })
    });
    if (!response.ok) fail('TLO_BACKEND_TRANSPORT_REJECTED', `Authenticated TLO backend transport rejected HTTP ${response.status}.`);
    const reply = await consumeOpenAiSse(response, onPartial);
    let capabilityContext = null;
    try { capabilityContext = JSON.parse(response.headers.get('X-EveOS-Capability-Context') || 'null'); }
    catch {}
    return { text: reply, ...(capabilityContext ? { capabilityContext } : {}) };
  }

  return Object.freeze({ streamChat });
}

module.exports = { AUTH_SCHEMA, AUTH_HEADER, canonical, createTloBackendTransport };
