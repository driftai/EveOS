const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_DIR = path.resolve(__dirname, '..', '..', 'js/modules/features/audioflix');
const readModule = (file) => fs.readFileSync(path.join(MODULE_DIR, file), 'utf8');
// audioflix.native.js delegates its localize/probe half to a sibling factory, so that has to be
// in the context before it loads.
const localizeSource = readModule('audioflix.native.localize.js');
const spotifySource = readModule('audioflix.native.spotify.js');
const instagramSource = readModule('audioflix.native.instagram.js');
const identitySource = readModule('audioflix.native.identity.js');
const routeStateSource = readModule('audioflix.native.route-state.js');
const source = readModule('audioflix.native.js');

let fetchCount = 0;
const fetchUrls = [];
let nativeState = { nativeBridgeBase: '' };
const windowObject = {
    location: { protocol: 'file:', origin: 'null' },
    EveAudioflixNative: {},
    EveAudioflixState: {
        ensure: () => nativeState,
        update: (patch) => {
            nativeState = Object.assign({}, nativeState, patch);
            return nativeState;
        }
    }
};

async function fakeFetch(url) {
    fetchCount += 1;
    const address = String(url);
    fetchUrls.push(address);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (address.endsWith('/api/status')) {
        return { ok: true, status: 200, json: async () => ({
            service: address.startsWith('http://127.0.0.1:8765')
                ? 'foreign-local-service' : 'eveos-local-server'
        }) };
    }
    if (address.startsWith('http://127.0.0.1:8765')) {
        throw new Error('Device request reached an unverified local service.');
    }
    if (String(url).includes('/api/audioflix/spotify-playlist')) {
        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: false, reason: 'Spotify playlist is private.' })
        };
    }
    return {
        ok: true,
        status: 200,
        json: async () => ({
            ok: true,
            devices: [
                { id: 'out-1', kind: 'output', name: 'CABLE Input' },
                { id: 'in-1', kind: 'input', name: 'CABLE Output' }
            ]
        })
    };
}

const context = vm.createContext({
    window: windowObject,
    location: windowObject.location,
    fetch: fakeFetch,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    Date,
    JSON
});
vm.runInContext(localizeSource, context, { filename: 'audioflix.native.localize.js' });
vm.runInContext(spotifySource, context, { filename: 'audioflix.native.spotify.js' });
vm.runInContext(instagramSource, context, { filename: 'audioflix.native.instagram.js' });
vm.runInContext(identitySource, context, { filename: 'audioflix.native.identity.js' });
vm.runInContext(routeStateSource, context, { filename: 'audioflix.native.route-state.js' });
vm.runInContext(source, context, { filename: 'audioflix.native.js' });

(async () => {
    const [outputs, inputs] = await Promise.all([
        windowObject.EveAudioflixNative.listSystemOutputs(),
        windowObject.EveAudioflixNative.listSystemInputs()
    ]);

    const expectedProbe = [
        'http://127.0.0.1:8765/api/status',
        'http://127.0.0.1:8766/api/status',
        'http://127.0.0.1:8766/api/audioflix/devices'
    ];
    if (JSON.stringify(fetchUrls) !== JSON.stringify(expectedProbe)) {
        throw new Error(`native bridge identity/probe drift: ${JSON.stringify(fetchUrls)}`);
    }
    if (windowObject.EveAudioflixNativeIdentity.isVerified('http://127.0.0.1:8765')
        || !windowObject.EveAudioflixNativeIdentity.isVerified('http://127.0.0.1:8766')) {
        throw new Error('bridge identity check accepted a foreign service or rejected EveOS');
    }
    if (outputs.devices.length !== 1 || outputs.devices[0].kind !== 'output') {
        throw new Error('output device filtering failed');
    }
    if (inputs.devices.length !== 1 || inputs.devices[0].kind !== 'input') {
        throw new Error('input device filtering failed');
    }
    if (nativeState.nativeBridgeBase !== 'http://127.0.0.1:8766') {
        throw new Error(`file-mode bridge did not retain the live fallback port: ${nativeState.nativeBridgeBase}`);
    }

    await windowObject.EveAudioflixNative.listSystemOutputs();
    if (fetchCount !== 3) throw new Error('cached device query unexpectedly probed the bridge again');

    const unavailable = await windowObject.EveAudioflixNative.listSpotifyPlaylist('https://open.spotify.com/playlist/private');
    if (unavailable.ok !== false || unavailable.reason !== 'Spotify playlist is private.') {
        throw new Error('application-level bridge failure was discarded instead of reaching the caller');
    }
    if (fetchCount !== 4 || !fetchUrls[3].startsWith('http://127.0.0.1:8766/api/audioflix/spotify-playlist?')) {
        throw new Error(`application-level bridge failure scanned other ports: ${JSON.stringify(fetchUrls)}`);
    }

    console.log('AUDIOFLIX_NATIVE_PROBE_SMOKE_OK');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
