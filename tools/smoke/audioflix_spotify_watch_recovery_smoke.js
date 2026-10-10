'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const relative = 'js/modules/features/audioflix/audioflix.spotify.status-watch.js';
const source = process.argv.includes('--baseline')
    ? execFileSync('git', ['show', `57487c76:${relative}`], { cwd: ROOT, encoding: 'utf8' })
    : fs.readFileSync(path.join(ROOT, relative), 'utf8');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

async function run() {
    const intervals = new Map(), timers = new Map(), reads = [], applied = [], states = [];
    let timerId = 0, runId = 1;
    const progress = [];
    const remote = {
        snapshot: () => ({ connected: true }),
        send() { const read = defer(); reads.push(read); return read.promise; },
        status() { const read = defer(); progress.push(read); return read.promise; }
    };
    const window = {};
    const context = vm.createContext({ window, document: { visibilityState: 'hidden' }, console,
        setInterval: (fn) => { intervals.set(++timerId, fn); return timerId; },
        clearInterval: id => intervals.delete(id),
        setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
        clearTimeout: id => timers.delete(id) });
    vm.runInContext(source, context);
    const watch = window.EveAudioflixSpotifyStatusWatch.create({
        remote: () => remote, isActive: () => true, currentRun: () => runId, isEnded: () => false,
        applyState: result => applied.push(result), onRecovery: result => states.push(result.state)
    });
    const state = cursor => ({ ok: true, watchSupported: true, isOwner: true,
        engine: { eventCursor: cursor }, ownerEpoch: 1, engineEpoch: 1, trackGeneration: 1 });
    const fireRetry = async () => {
        assert.equal(timers.size, 1, 'one bounded retry must survive a transient failure');
        const [id, job] = [...timers][0]; timers.delete(id); job.fn(); await flush();
    };
    watch.start(state(1));
    reads[0].resolve({ ok: false, timeout: true }); await flush();
    await fireRetry();
    assert.equal(reads.length, 2, 'watch must recover rather than exit forever');
    reads[1].resolve(state(2)); await flush();
    assert.equal(applied.at(-1).engine.eventCursor, 2);
    const held = reads.at(-1);
    // Rapid start/stop must retain one bounded request/job, not one per cycle.
    for (let i = 0; i < 50; i++) { watch.stop(); runId++; watch.start(state(3)); }
    assert.equal(reads.length, 3);
    assert.equal(watch.diagnostics().watchJobs, 1);
    assert.equal(intervals.size, 1);
    held.resolve(state(2)); await flush();
    assert.equal(reads.length, 4);
    assert.equal(applied.length, 1, 'old run must not repaint after restart');
    const poll = watch.progressOnce();
    reads.at(-1).resolve(state(5)); await flush();
    progress[0].resolve(state(4)); await poll;
    assert.equal(applied.at(-1).engine.eventCursor, 5, 'late progress must not regress watch state');
    // Exhaustion is finite and disables even the presentation polling timer.
    const terminalPoll = watch.progressOnce();
    for (let i = 0; i < 5; i++) {
        reads.at(-1).resolve({ ok: false, unavailable: true }); await flush();
        if (i < 4) await fireRetry();
    }
    assert.equal(watch.diagnostics().state, 'degraded');
    assert.equal(intervals.size, 0); assert.equal(timers.size, 0);
    const acceptedBefore = applied.length;
    progress[1].resolve(state(99)); await terminalPoll;
    assert.equal(applied.length, acceptedBefore, 'late poll cannot resurrect degraded observation');
    watch.stop(); await flush();
    assert.equal(watch.diagnostics().watchJobs, 0);
    assert.equal(watch.diagnostics().watchRequests, 0);
    assert(states.includes('reconnecting') && states.includes('degraded'));
}
run().then(() => console.log('AUDIOFLIX_SPOTIFY_WATCH_RECOVERY_OK (retry, stale reads, 50 cycles, bounded exhaustion)'))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
