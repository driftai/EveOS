'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.repeat-rearm.js'), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };

async function main() {
    let ended = true;
    let connected = true;
    const remoteActions = [];
    const seekCalls = [];
    const listeners = new Map();

    const window = {
        EveAudioflixAudio: {
            ready: true,
            async seek(seconds) { seekCalls.push(Number(seconds)); return `seek:${seconds}`; }
        },
        EveAudioflixSpotifyAnyBrowser: {
            ready: true,
            snapshot: () => ({ active: true, ended })
        },
        EveAudioflixSpotifyRemote: {
            ready: true,
            snapshot: () => ({ connected }),
            async send(action) {
                remoteActions.push(action);
                if (action !== 'restart') return { ok: false, reason: `Unexpected action ${action}` };
                setTimeout(() => { ended = false; }, 5);
                return { ok: true };
            }
        },
        addEventListener(name, handler) { listeners.set(name, handler); },
        setTimeout,
        clearTimeout,
        Date,
        Promise
    };
    window.window = window;

    vm.runInNewContext(source, window, { filename: 'audioflix.spotify.repeat-rearm.js' });
    assert(window.EveAudioflixSpotifyRepeatRearm?.ready === true, 'repeat rearm module initializes');
    assert(window.EveAudioflixAudio.seek.__eveSpotifyRepeatRearm === true, 'managed seek wrapper installs');

    await window.EveAudioflixAudio.seek(0);
    assert(remoteActions.join(',') === 'restart', 'ended Spotify seek-to-zero uses the existing restart command');
    assert(seekCalls.length === 0, 'successful restart does not issue a second seek after the poll observes Playing');
    assert(ended === false, 'restart clears the managed durable Ended state before queue replay continues');

    await window.EveAudioflixAudio.seek(12);
    assert(seekCalls.length === 1 && seekCalls[0] === 12, 'ordinary managed seek keeps the existing seek path');

    ended = true;
    connected = false;
    await window.EveAudioflixAudio.seek(0);
    assert(remoteActions.length === 1, 'disconnected managed transport does not invent a restart command');
    assert(seekCalls.length === 2 && seekCalls[1] === 0, 'disconnected ended seek falls back to the existing seek behavior');

    console.log('AUDIOFLIX_SPOTIFY_REPEAT_REARM_SMOKE_OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
