'use strict';

const assert = require('node:assert/strict');

module.exports = async function checkManagedNativeCapture({
    window, calls, spotify, setRoute, setCapture, applyState, engineState
}) {
    await window.EveAudioflixAudio.stopAll();
    setRoute(true);
    const item = { ...spotify, id: 'song-native-capture' };
    await assert.rejects(() => window.EveAudioflixAudio.playItem(item), /arm.*Capture Engine/i,
        'native managed Spotify refuses to leak to the default output without its exact capture');
    setCapture({ active: true, source: 'provider-tab', endpoint: 'sd:cable' });
    await assert.rejects(() => window.EveAudioflixAudio.playItem(item), /arm.*Capture Engine/i,
        'a different captured tab cannot impersonate the managed Spotify route');
    setCapture({ active: true, source: 'managed-spotify', endpoint: 'sd:other' });
    await assert.rejects(() => window.EveAudioflixAudio.playItem(item), /arm.*Capture Engine/i,
        'a managed capture bound to another endpoint cannot satisfy the route');
    setCapture({ active: true, source: 'managed-spotify', endpoint: 'sd:cable' });
    await window.EveAudioflixAudio.playItem(item);
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
