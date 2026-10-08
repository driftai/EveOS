'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.volume.js'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeContext({ managed = true } = {}) {
    const calls = [];
    const listeners = new Map();
    let failVolume = false;
    const session = managed ? 'managed-session-smoke' : '';
    const window = {
        __EveAudioflixManagedBrowserSession: session,
        EveAudioflixOutputPort: { effective: (value) => Number(value) * 0.5 },
        EveAudioflixAudio: {
            getPlaybackState: () => ({
                provider: 'spotify',
                item: {
                    id: 'song-1',
                    type: 'music',
                    sourceProvider: 'spotify',
                    url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
                    volume: 0.5
                }
            })
        },
        addEventListener(name, fn) { listeners.set(name, fn); }
    };
    const fetch = async (url, options = {}) => {
        calls.push({ url, options });
        if (String(url).endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    ok: true,
                    helperReachable: managed,
                    sessionId: session,
                    authState: 'signed-in'
                })
            };
        }
        if (String(url).endsWith('/volume')) {
            if (failVolume) throw new Error('helper offline');
            const body = JSON.parse(options.body || '{}');
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    ok: true,
                    sessionMatch: true,
                    volume: body.volume,
                    lastAppliedAt: 777
                })
            };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const context = { window, fetch, Promise, setTimeout, clearTimeout, console };
    window.fetch = fetch;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'audioflix.spotify.volume.js' });
    return {
        window,
        calls,
        listeners,
        setFailVolume(value) { failVolume = value; }
    };
}

(async () => {
    const managed = makeContext({ managed: true });
    await sleep(10); // allow startup status probe
    let snap = managed.window.EveAudioflixSpotifyVolume.snapshot();
    assert.equal(snap.directControl, true, 'managed browser exposes volume control capability');
    assert.equal(snap.authState, 'signed-in');

    const effective = managed.window.EveAudioflixSpotifyVolume.setSpotifyVolume(0.5, {
        direct: false,
        item: {
            sourceProvider: 'spotify',
            url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'
        }
    });
    assert.equal(effective, 0.25, 'track 50% x output/master 50% = effective 25%');
    await sleep(10);
    const volumeCall = managed.calls.filter((entry) => String(entry.url).endsWith('/volume')).at(-1);
    assert.ok(volumeCall, 'managed volume call was issued');
    const body = JSON.parse(volumeCall.options.body);
    assert.equal(body.sessionId, 'managed-session-smoke');
    assert.equal(body.trackId, '4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(body.volume, 0.25);
    snap = managed.window.EveAudioflixSpotifyVolume.snapshot();
    assert.equal(snap.lastAck, 777);
    assert.equal(snap.directControl, true);

    // Master/output changes re-use raw item volume and must not apply the 0.5 factor twice.
    managed.listeners.get('eve:audioflix-output-volume')?.();
    await sleep(10);
    const afterMaster = managed.calls.filter((entry) => String(entry.url).endsWith('/volume')).at(-1);
    assert.equal(JSON.parse(afterMaster.options.body).volume, 0.25, 'master sync does not double-attenuate');

    managed.setFailVolume(true);
    managed.window.EveAudioflixSpotifyVolume.setSpotifyVolume(0.4, { direct: false });
    await sleep(10);
    snap = managed.window.EveAudioflixSpotifyVolume.snapshot();
    assert.equal(snap.helperReachable, false);
    assert.equal(snap.managedControl, false);
    assert.equal(snap.directControl, false, 'helper failure downgrades fake direct control immediately');
    assert.match(snap.message, /unavailable|managed/i);

    const ordinary = makeContext({ managed: false });
    await sleep(5);
    snap = ordinary.window.EveAudioflixSpotifyVolume.snapshot();
    assert.equal(snap.directControl, false, 'ordinary browser cannot impersonate managed Spotify volume control');
    ordinary.window.EveAudioflixSpotifyVolume.setSpotifyVolume(0.2, { direct: false });
    await sleep(5);
    assert.equal(ordinary.calls.filter((entry) => String(entry.url).endsWith('/volume')).length, 0,
        'ordinary browser never sends managed-volume commands');

    console.log('AUDIOFLIX_VOLUME_MANAGED_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });
