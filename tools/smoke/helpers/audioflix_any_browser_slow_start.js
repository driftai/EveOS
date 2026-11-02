'use strict';
const assert = require('node:assert/strict');

// Extracted intact from the established managed Spotify browser smoke.
// Preserve its real asynchronous preemption behavior, including stop and pause.
module.exports = async function checkManagedSlowStart({ window, remote, spotify, calls }) {
    // A remote start still in flight is not active yet, but switching away or pausing must still
    // reach the broker so it can preempt that start; a preempted start is not a broken track.
    {
        await window.EveAudioflixAudio.stopAll();
        const realSend = remote.send;
        let releasePlay;
        remote.send = async (action, payload = {}, options = {}) => {
            if (action !== 'play') return realSend(action, payload, options);
            calls.push({ action, payload: { ...payload }, options: { ...options } });
            return new Promise(resolve => { releasePlay = resolve; });
        };
        const slow = window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-slow' });
        await new Promise(resolve => setTimeout(resolve, 20));
        const stopsBefore = calls.filter(entry => entry.action === 'stop').length;
        await window.EveAudioflixAudio.playItem({ id: 'local-switch', url: 'https://example.com/a.mp3', sourceProvider: 'direct' });
        assert.equal(calls.filter(entry => entry.action === 'stop').length, stopsBefore + 1, 'switching to a local track during a slow Spotify start sends broker stop');
        releasePlay({ ok: false, lifecycle: 'stopped', superseded: true });
        assert.equal(await slow, false, 'the stopped start resolves as superseded, not as a failure');

        const paused = window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-slow-2' });
        await new Promise(resolve => setTimeout(resolve, 20));
        const pausesBefore = calls.filter(entry => entry.action === 'pause').length;
        await window.EveAudioflixAudio.pause();
        assert.equal(calls.filter(entry => entry.action === 'pause').length, pausesBefore + 1, 'Pause during a slow start reaches the broker instead of the idle local player');
        releasePlay({ ok: false, lifecycle: 'paused', superseded: true });
        assert.equal(await paused, false, 'a start preempted by Pause is not reported as a skip');
        remote.send = realSend;
    }

};
