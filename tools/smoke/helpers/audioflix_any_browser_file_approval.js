'use strict';
// Regression: file:// is untrusted until the existing explicit approval completes.
const assert = require('node:assert/strict');
module.exports = async function checkFileApprovalBeforeCapture({
    window, remote, calls, spotify, setRoute, setCapture, document
}) {
    await window.EveAudioflixAudio.stopAll();
    setRoute(true);
    setCapture({ active: false, source: '', endpoint: '' });
    const original = {
        connect: remote.connect, snapshot: remote.snapshot,
        waitUntilReady: remote.waitUntilReady, appendChild: document.body.appendChild
    };
    let approved = false;
    let shown = false;
    const start = calls.length;
    remote.connect = async () => approved
        ? original.connect()
        : { connected: false, approvalRequired: true, code: '123456',
            approvalUrl: 'http://127.0.0.1:8765/api/audioflix/spotify-approval?pair=test' };
    remote.snapshot = () => ({ ...original.snapshot(), connected: approved,
        approvalRequired: !approved, relayReady: true });
    document.body.appendChild = function (box) {
        if (box?.dataset?.eveSpotifyApproval) shown = true;
        return original.appendChild.call(this, box);
    };
    remote.waitUntilReady = async () => {
        assert.ok(shown, 'file approval prompt must be visible before capture is requested');
        assert.ok(!calls.slice(start).some(entry => ['engine-capture-start', 'play'].includes(entry.action)),
            'neither native capture nor Spotify Play may start before file approval');
        approved = true;
        return { connected: true };
    };
    try {
        await window.EveAudioflixAudio.playItem({ ...spotify, id: 'file-origin-native-approval' });
        assert.ok(shown, 'file-origin pairing prompt was displayed');
        const activity = calls.slice(start).map(entry => entry.action);
        const capture = activity.indexOf('engine-capture-start');
        const play = activity.indexOf('play');
        assert.ok(capture >= 0 && play > capture,
            'FILE_ORIGIN_APPROVAL_BEFORE_PCM: authorized native capture must precede Play');
        await window.EveAudioflixAudio.stopAll();
    } finally {
        remote.connect = original.connect;
        remote.snapshot = original.snapshot;
        remote.waitUntilReady = original.waitUntilReady;
        document.body.appendChild = original.appendChild;
        setRoute(false);
        setCapture({ active: false, source: '', endpoint: '' });
    }
};
