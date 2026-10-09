'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const http = read('server_modules/audioflix_spotify_http.py');
const relay = read('server_modules/audioflix_spotify_relay.py');
const broker = read('server_modules/audioflix_spotify_broker.py');
const remote = read('js/modules/features/audioflix/audioflix.spotify.remote.js');
const hook = read('server_modules/audioflix_spotify_browser_hook.js');
const helper = read('server_modules/audioflix_spotify_browser.js');

assert(http.includes('origin == _server_origin(handler).lower()')
    && !http.includes('Access-Control-Allow-Origin", "null"'),
    'Spotify broker POSTs require the exact localhost relay origin and never CORS-whitelist null origin');
assert(http.includes('X-Frame-Options", "DENY"') && http.includes("frame-ancestors 'none'"),
    'trusted file approval page is not frameable');
assert(relay.includes("event.source !== parent") && relay.includes("event.origin !== 'null' && event.origin !== RELAY_ORIGIN"),
    'relay verifies the source window and exact ordinary origin before accepting a MessageChannel');
assert(relay.includes('new MessageChannel') === false,
    'relay consumes a transferred channel rather than manufacturing authority for an arbitrary parent');
assert(relay.includes("type: 'pairing-required'") && relay.includes("/api/audioflix/spotify-client/pair-status"),
    'opaque/file parent gets an explicit pending pairing flow');
assert(relay.includes('clientToken = String(result.clientToken)')
    && !relay.includes("clientToken: clientToken")
    && !relay.includes("type: 'ready', clientToken"),
    'relay-scoped credential remains in iframe memory and is never posted to the parent');
assert(broker.includes('secrets.compare_digest') && broker.includes('csrf') && broker.includes('pairingRequired'),
    'file pairing requires single-use trusted approval evidence');
assert(remote.includes('MessageChannel') && remote.includes('eveos:spotify-relay-connect')
    && remote.includes("location.protocol === 'file:'"),
    'ordinary localhost and file clients share the typed relay client');
assert(!remote.includes('clientToken'),
    'parent-side Spotify client source never handles the scoped broker token');
assert(!hook.includes('__EveAudioflixManagedBrowserSession') && !hook.includes('sessionId'),
    'no private helper session material is injected into EveOS or Spotify frames');
assert(helper.includes("requestUrl.pathname === '/transport'")
    && !helper.includes("requestUrl.pathname === '/eval'")
    && !helper.includes("requestUrl.pathname === '/evaluate'"),
    'helper exposes fixed Spotify transport commands and no arbitrary evaluation API');

console.log('AUDIOFLIX_SPOTIFY_RELAY_SECURITY_SMOKE_OK');
