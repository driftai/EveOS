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
    && !http.includes('Access-Control-Allow-Origin\", \"null\"'),
    'Spotify broker POSTs require the exact localhost relay origin and never CORS-whitelist null origin');
assert(http.includes("frame-ancestors * file:") && http.includes('X-Frame-Options\", \"DENY\"')
    && http.includes("frame-ancestors 'none'"),
    'relay is frameable from network/file EveOS while the trusted approval page remains non-frameable');
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
assert(relay.includes('let commandChain = Promise.resolve()')
    && relay.includes('commandChain = commandChain.then(() => forwardCommand(message)'),
    'ordered playback requests are serialized so clientCommandSeq cannot be reordered by concurrent HTTP requests');
assert(relay.includes("new Set(['status', 'import', 'auth'])") && relay.includes('void forwardCommand(message)'),
    'status and long import/auth jobs use the broker independent lane so playback controls stay responsive');
assert(broker.includes('\"jobSeq\": 0') && broker.includes('seq_key = \"jobSeq\" if action in {\"import\", \"auth\"} else \"seq\"'),
    'broker keeps long jobs on a separate replay/order high-water boundary');
assert(broker.includes('secrets.compare_digest') && broker.includes('csrf') && broker.includes('pairingRequired'),
    'file pairing requires single-use trusted approval evidence');
assert(remote.includes('MessageChannel') && remote.includes('eveos:spotify-relay-connect')
    && remote.includes("location.protocol === 'file:'"),
    'ordinary localhost and file clients share the typed relay client');
assert(remote.includes("message.type !== 'eveos:spotify-relay-ready'")
    && remote.includes('event.source !== iframe?.contentWindow')
    && remote.includes('event.origin !== relayOrigin')
    && remote.includes('state.relayReady = true'),
    'parent trusts managed transport only after an exact source+origin relay-ready handshake');
assert(remote.includes('No EveOS Spotify relay answered') && remote.includes('state.relayReady = false'),
    'missing relay handshake is distinguishable from a failure after the trusted relay has answered');
assert(remote.includes("setTimeout(() => finish(false, new Error('Spotify relay approval timed out.'))")
    && remote.includes('clearTimeout(timer)'),
    'file approval wait is bounded even when no later relay notification arrives');
assert(!remote.includes('clientToken'),
    'parent-side Spotify client source never handles the scoped broker token');
assert(!hook.includes('__EveAudioflixManagedBrowserSession') && !hook.includes('sessionId'),
    'no private helper session material is injected into EveOS or Spotify frames');
assert(helper.includes("requestUrl.pathname === '/transport'")
    && !helper.includes("requestUrl.pathname === '/eval'")
    && !helper.includes("requestUrl.pathname === '/evaluate'"),
    'helper exposes fixed Spotify transport commands and no arbitrary evaluation API');

console.log('AUDIOFLIX_SPOTIFY_RELAY_SECURITY_SMOKE_OK');