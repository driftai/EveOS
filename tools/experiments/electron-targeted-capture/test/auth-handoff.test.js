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
