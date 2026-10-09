'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.volume.js'), 'utf8');

function makeContext() {
    const listeners = new Map();
    let connected = false;
    const remote = {
        ready: true,
        snapshot: () => ({ connected, status: connected ? 'ready' : 'idle', approvalRequired: false }),
        connect: async () => ({ connected }),
        status: async () => ({
            ok: true, connected, managed: { helperReachable: connected, authState: 'signed-in' }
        }),
        send: async () => ({ ok: true, authState: 'signed-in' })
    };
    const window = {
        EveAudioflixSpotifyRemote: remote,
        EveAudioflixOutputPort: { effective: (value) => Number(value) * 0.5 },
        EveAudioflixAudio: {
            getPlaybackState: () => ({
                provider: 'spotify', remoteManaged: false,
                item: {
                    id: 'song-1', type: 'music', sourceProvider: 'spotify',
                    url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', volume: 0.5
                }
            })
        },
        addEventListener(name, fn) { listeners.set(name, fn); }
    };
    const context = { window, Promise, console };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'audioflix.spotify.volume.js' });
    return { window, listeners, setConnected(value) { connected = value === true; } };
}

(async () => {
    assert.doesNotMatch(source, /__EveAudioflixManagedBrowserSession/,
        'volume coordinator no longer consumes the retired injected browser session marker');
    assert.doesNotMatch(source, /sessionId\s*:/,
        'volume coordinator never sends private helper session ids');
    assert.doesNotMatch(source, /\/api\/audioflix\/spotify-browser\/volume/,
        'ordinary tabs do not call the private helper volume endpoint directly');

    const ctx = makeContext();
    const volume = ctx.window.EveAudioflixSpotifyVolume;
    let snap = volume.snapshot();
    assert.equal(snap.directControl, false);

    const alreadyEffective = volume.setSpotifyVolume(0.25, { direct: false });
    assert.equal(alreadyEffective, 0.25,
        'provider setVolume accepts an already-effective gain and never multiplies master twice');
    snap = volume.snapshot();
    assert.equal(snap.volume, 0.25);
    assert.equal(snap.status, 'provider-owned');

    volume.setSpotifyVolume(0.4, { direct: true });
    snap = volume.snapshot();
    assert.equal(snap.directControl, true, 'a future real iframe controller volume API remains supported');
    assert.equal(snap.volume, 0.4);

    volume.clearSpotify();
    ctx.setConnected(true);
    snap = volume.snapshot();
    assert.equal(snap.managedControl, true, 'authorized relay connection exposes managed gain capability');
    assert.equal(snap.directControl, true);
    await volume.refreshManagedStatus();
    snap = volume.snapshot();
    assert.equal(snap.authState, 'signed-in');
    assert.equal(snap.helperReachable, true);

    // Raw playback item gain is multiplied by OutputPort exactly once only when syncing from state.
    ctx.setConnected(false);
    volume.syncSpotifyFromPlayback(0.5);
    snap = volume.snapshot();
    assert.equal(snap.volume, 0.25, 'raw track 50% x output/master 50% = 25% exactly once');

    const child = spawnSync(process.execPath, [path.join(ROOT, 'tools/smoke/audioflix_spotify_any_browser_smoke.js')], {
        cwd: ROOT, stdio: 'inherit', env: process.env
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, 'any-browser gain/transport smoke passes');

    console.log('AUDIOFLIX_VOLUME_MANAGED_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });
