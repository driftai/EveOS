'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const managed = require('../../../../server_modules/audioflix_spotify_auth_handoff.js');
const direct = require('../session-handoff.js');

test('managed handoff exports only authenticated Spotify cookies', async () => {
  const result = await managed.capture({ cookies: async () => [
    { name: 'sp_dc', value: 'AUTH', domain: '.spotify.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
    { name: 'sp_t', value: 'TRACKING', domain: '.spotify.com', path: '/' },
    { name: 'sp_key', value: 'KEY', domain: 'open.spotify.com', path: '/', sameSite: 'Lax' },
    { name: 'sp_dc', value: 'EVIL', domain: '.evil.test', path: '/' }
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cookies.map((cookie) => cookie.name), ['sp_dc', 'sp_key']);
  assert.equal(JSON.stringify(result).includes('TRACKING'), false);
  assert.equal(JSON.stringify(result).includes('EVIL'), false);
});

test('direct handoff is bounded, validates the envelope, and installs no unrelated cookies', async () => {
  const stored = [];
  const target = { cookies: {
    async set(cookie) { stored.push(cookie); },
    async get() { return stored; }
  } };
  const envelope = { version: 1, cookies: [
    { name: 'sp_dc', value: 'AUTH', domain: '.spotify.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'sp_t', value: 'NO', domain: '.spotify.com', path: '/' }
  ] };
  const result = await direct.apply(target, { enabled: true, envelope });
  assert.deepEqual(result, { applied: true, count: 1 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sameSite, 'no_restriction');
  await assert.rejects(() => direct.apply(target, { enabled: true,
    envelope: { version: 2, cookies: [] } }), /version/);
});


test('Direct reuses only valid saved Electron auth; never imports cookies in reuse mode', async () => {
  const stored = [
    { name: 'sp_dc', value: 'AUTH', domain: '.spotify.com', secure: true, expirationDate: Date.now()/1000 + 3600 },
    { name: 'sp_dc', value: 'TRACKER', domain: '.evil.test', secure: true },
    { name: 'sp_key', value: 'EXPIRED', domain: '.spotify.com', secure: true, expirationDate: 100 },
    { name: 'sp_key', value: 'INSECURE', domain: '.spotify.com', secure: false }
  ];
  let setCount = 0;
  const target = { cookies: {
    async get(options) { assert.deepEqual(options, { url: 'https://open.spotify.com' }); return stored; },
    async set() { setCount++; }
  } };
  const envelope = { version: 1, mode: 'reuse-persisted', cookies: [] };
  assert.deepEqual(await direct.apply(target, { enabled: true, envelope }),
    { applied: true, count: 1, source: 'persisted' });
  assert.equal(setCount, 0);
  stored.splice(0, stored.length);
  await assert.rejects(() => direct.apply(target, { enabled: true, envelope }), /no valid saved sign-in/);
  await assert.rejects(() => direct.apply(target, { enabled: true,
    envelope: { ...envelope, cookies: [{ name: 'sp_dc', value: 'secret' }] } }), /cannot import/);
  await assert.rejects(() => direct.apply(target, { enabled: true,
    envelope: { ...envelope, mode: 'unsupported' } }), /Unsupported/);
});
