'use strict';

const assert = require('node:assert/strict');

module.exports = async function checkManagedNativeCapture({
    window, calls, spotify, setRoute, setCapture, applyState, engineState
}) {
    await window.EveAudioflixAudio.stopAll();
    setRoute(true);
    const item = { ...spotify, id: 'song-native-capture' };
    await window.EveAudioflixAudio.playItem(item);
    const captureIndex = calls.findLastIndex(entry => entry.action === 'engine-capture-start');
    const playIndex = calls.findIndex((entry, index) => index > captureIndex && entry.action === 'play');
    assert.equal(calls[captureIndex]?.payload?.deviceId, 'sd:cable', 'Play automatically arms the exact native endpoint');
    assert.ok(captureIndex >= 0 && captureIndex < playIndex, 'PCM capture is active before Spotify playback can begin');
    assert.equal(window.EveAudioflixSpotifyNativeCapture.status().active, true);
    const before = calls.filter(entry => entry.action === 'pause').length;
    const lost = { active: false, source: '', endpoint: '', state: 'idle' };
    setCapture(lost);
    applyState({ ok: true, isOwner: true, engine: { ...engineState() },
        managed: { helperReachable: true, capture: lost } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(calls.filter(entry => entry.action === 'pause').length, before + 1,
        'losing managed PCM capture pauses Spotify instead of leaking to speakers');
    await window.EveAudioflixAudio.stopAll();
    setRoute(false);
};
