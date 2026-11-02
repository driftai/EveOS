'use strict';
// Restarted Playwright pages must not inherit an ordinary tab's stale same-track lease.
const assert = require('node:assert/strict');
module.exports = async function checkRestartedTrackRebind({
    window, calls, spotify, setEngineState, engineState
}) {
    const audio = window.EveAudioflixAudio;
    const count = (action) => calls.filter(entry => entry.action === action).length;
    await audio.pause();
    setEngineState({ ...engineState(), status: 'idle', spotifyId: '',
        paused: true, currentTime: 0 });
    const beforePlay = count('play'), beforeResume = count('resume');
    assert.equal(await audio.playItem(spotify), true,
        'same selected song must acquire a fresh Play after the managed Engine resets');
    assert.equal(count('play'), beforePlay + 1,
        'idle Engine is reloaded instead of resuming its previous playback lease');
    assert.equal(count('resume'), beforeResume,
        'restart must not issue Resume against the idle replacement Engine');
    assert.equal(window.EveAudioflixSpotifyAnyBrowser.snapshot().item.id, spotify.id);
    await audio.pause();
    const livePlay = count('play'), liveResume = count('resume');
    assert.equal(await audio.playItem(spotify), true,
        'ordinary pause/resume must continue using the same existing live Engine');
    assert.equal(count('play'), livePlay, 'valid same-song playback is not unnecessarily reloaded');
    assert.equal(count('resume'), liveResume + 1, 'valid live lease resumes normally');
};
