'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.remote.js'),
    'utf8'
);

function boot(href) {
    const parsed = new URL(href);
    const appended = [];
    const iframeListeners = new Map();
    const windowListeners = new Map();
    const storage = new Map();
    const makeIframe = () => ({
        hidden: false,
        tabIndex: 0,
        src: '',
        setAttribute() {},
        addEventListener(name, fn) { iframeListeners.set(name, fn); },
        remove() {},
        contentWindow: { postMessage() {} }
    });
    const document = {
        documentElement: { appendChild(node) { appended.push(node); } },
        createElement(tag) { return tag === 'iframe' ? makeIframe() : {}; },
        addEventListener() {},
        visibilityState: 'visible'
    };
    const location = {
        protocol: parsed.protocol,
        origin: parsed.protocol === 'file:' ? 'null' : parsed.origin,
        pathname: parsed.pathname
    };
    const window = {
        EveAudioflixState: { ensure: () => ({}) },
        addEventListener(name, fn) { windowListeners.set(name, fn); },
        removeEventListener(name, fn) {
            if (windowListeners.get(name) === fn) windowListeners.delete(name);
        },
        open: () => ({}),
        location
    };
    window.window = window;
    const simpleStorage = {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); }
    };
    const context = {
        window,
        document,
        location,
        sessionStorage: simpleStorage,
        localStorage: simpleStorage,
        URL,
        Promise,
        Map,
        Set,
        Number,
        String,
        Math,
        Date,
        Error,
        JSON,
        setTimeout,
        clearTimeout,
        setInterval: () => 1,
        clearInterval() {},
        crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
        MessageChannel: class MessageChannel {
            constructor() {
                this.port1 = { start() {}, close() {}, postMessage() {} };
                this.port2 = {};
            }
        },
        BroadcastChannel: class BroadcastChannel {
            constructor() { this.onmessage = null; }
            postMessage() {}
            close() {}
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'audioflix.spotify.remote.js' });
    const pending = window.EveAudioflixSpotifyRemote.connect();
    assert.ok(pending && typeof pending.then === 'function');
    assert.equal(appended.length, 1, 'connect creates one hidden relay iframe');

    const iframe = appended[0];
    const relayOrigin = new URL(iframe.src).origin;
    const handshake = windowListeners.get('message');
    assert.equal(typeof handshake, 'function', 'client waits for an authenticated relay-ready handshake');
    handshake({
        source: iframe.contentWindow,
        origin: relayOrigin,
        data: { type: 'eveos:spotify-relay-ready', protocolVersion: 1 }
    });
    assert.equal(window.EveAudioflixSpotifyRemote.snapshot().relayReady, true,
        'exact source+origin relay-ready handshake marks the relay reachable');
    return { iframe, remote: window.EveAudioflixSpotifyRemote };
}

const localhost = boot('http://127.0.0.1:8765/EveOS.html');
assert.equal(
    localhost.iframe.src,
    'http://127.0.0.1:8765/api/audioflix/spotify-relay',
    'ordinary localhost EveOS uses its exact canonical broker origin'
);

const file = boot('file:///C:/Users/alvin/Documents/Workspace/RoughProjDeving/EveOS/EveOS.html');
assert.equal(
    file.iframe.src,
    'http://127.0.0.1:8765/api/audioflix/spotify-relay',
    'absolute file EveOS reaches the canonical loopback relay without direct CORS control calls'
);
assert.equal(file.remote.snapshot().base, 'http://127.0.0.1:8765');

assert.match(source, /BroadcastChannel/,
    'file-tab identity uses a live-tab channel to detect a duplicated sessionStorage document id');
assert.match(source, /audioflix:spotify-claim/,
    'file-tab identity keeps a short localStorage heartbeat as a duplicate-detection fallback');
assert.match(source, /claimedDocumentId\(\)/,
    'relay hello waits for the collision-safe file document identity');
assert.match(source, /releaseDocumentIdentity\(\); disconnect\(\)/,
    'pagehide releases the file-tab identity claim before disconnecting');
assert.doesNotMatch(source, /clientToken/,
    'ordinary parent client source never receives the relay-scoped broker credential');
assert.doesNotMatch(source, /Access-Control-Allow-Origin/,
    'ordinary client does not depend on a null-origin CORS exception');

console.log('AUDIOFLIX_SPOTIFY_ENTRYPOINTS_SMOKE_OK');