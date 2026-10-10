'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const relative = 'js/modules/features/audioflix/audioflix.spotify.status-watch.js';
const revision = process.argv.find(arg => arg.startsWith('--revision='))?.slice('--revision='.length);
if (revision) assert.match(revision, /^[0-9a-f]{7,40}$/i, 'Regression source revision must be a commit SHA');
const sourceRevision = revision || (process.argv.includes('--baseline') ? '57487c76' : null);
const source = sourceRevision
    ? execFileSync('git', ['show', `${sourceRevision}:${relative}`], { cwd: ROOT, encoding: 'utf8' })
    : fs.readFileSync(path.join(ROOT, relative), 'utf8');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const artifact = path.join(ROOT, 'data/runtime/smoke-results/audioflix-watch-recovery.json');
const evidence = { sourceRevision: sourceRevision || 'working-tree', phase: 'recovery-and-stale-reads',
    scenarios: [], repeatTrace: [] };

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
    evidence.scenarios.push('retry-stale-reads-rapid-start-stop-exhaustion');
    await sameTrackRepeatAfterEnded();
}

async function sameTrackRepeatAfterEnded() {
    evidence.phase = 'hidden-same-uri-repeat-after-ended';
    const intervals = new Map(), timers = new Map(), listeners = new Map(), reads = [];
    const completions = [], consumed = new Set();
    let timerId = 0, active = true, ended = false, flights = 0, peakFlights = 0, statusReads = 0;
    const run = 1, spotifyId = 'same-fixture-track';
    const document = { visibilityState: 'hidden',
        addEventListener(name, handler) { listeners.set(name, handler); },
        removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); } };
    const packet = (status, cursor, generation) => ({ ok: true, watchSupported: true, isOwner: true,
        ownerEpoch: 1, engineEpoch: 1, trackGeneration: generation,
        engine: { spotifyId, status, paused: status !== 'playing', ended: status === 'ended',
            generation, eventCursor: cursor, completionId: status === 'ended' ? `done-${generation}-${cursor}` : '' } });
    const remote = { snapshot: () => ({ connected: true }),
        send(action, payload) {
            assert.equal(action, 'status-watch');
            const read = defer(); reads.push({ ...read, payload });
            flights++; peakFlights = Math.max(peakFlights, flights);
            assert.equal(flights, 1, 'Same-track repeat must never overlap authoritative watches');
            return read.promise.finally(() => { flights--; });
        },
        status() { statusReads++; throw Error('Hidden completion must not depend on presentation polling'); } };
    const window = {};
    vm.runInContext(source, vm.createContext({ window, document, console,
        setInterval: fn => { intervals.set(++timerId, fn); return timerId; },
        clearInterval: id => intervals.delete(id),
        setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
        clearTimeout: id => timers.delete(id) }));
    const watch = window.EveAudioflixSpotifyStatusWatch.create({ remote: () => remote,
        isActive: () => active, currentRun: () => run, isEnded: () => ended,
        applyState(result) {
            const engine = result.engine;
            if (engine.status === 'playing') ended = false;
            if (engine.ended) {
                ended = true;
                // Like the Audioflix client, emit each durable completion identity once.
                if (!consumed.has(engine.completionId)) { consumed.add(engine.completionId); completions.push(engine.completionId); }
            }
        } });
    const trace = step => evidence.repeatTrace.push({ step, active, ended, run, visibility: document.visibilityState,
        reads: reads.length, flights, peakFlights, statusReads, completions: [...completions], diagnostics: watch.diagnostics() });
    const bounded = () => {
        const counts = watch.diagnostics();
        assert.equal(counts.watchJobs, 1); assert.equal(counts.watchRequests, 1);
        assert.equal(counts.progressRequests, 0); assert.equal(counts.retryTimers, 0);
        assert.equal(counts.progressTimers, 1); assert.equal(intervals.size, 1);
        assert.equal(timers.size, 0); assert.equal(peakFlights, 1); assert.equal(statusReads, 0);
    };
    try {
        watch.start(packet('playing', 1, 1)); await flush(); bounded(); trace('started-hidden');
        reads[0].resolve(packet('ended', 2, 1)); await flush(); trace('first-ended');
        assert.deepEqual(completions, ['done-1-2']); assert.equal(ended, true);
        assert.equal(reads.length, 2, 'Active hidden client must retain its watch after Ended for same-track repeat');
        bounded(); assert.equal(reads[1].payload.afterCursor, 2);
        // A transport restart advances the engine generation/cursor without creating a new client run.
        reads[1].resolve(packet('playing', 3, 2)); await flush(); trace('same-uri-restarted-playing');
        assert.equal(ended, false); assert.equal(reads.length, 3); bounded();
        assert.equal(reads[2].payload.afterTrackGeneration, 2); assert.equal(reads[2].payload.afterCursor, 3);
        reads[2].resolve(packet('ended', 4, 2)); await flush(); trace('second-ended');
        assert.deepEqual(completions, ['done-1-2', 'done-2-4'], 'Second same-track completion must be delivered exactly once');
        assert.equal(reads.length, 4); bounded();
        // A bounded watch timeout can repeat the durable terminal packet without emitting another Ended.
        reads[3].resolve({ ...packet('ended', 4, 2), watchTimedOut: true }); await flush(); trace('terminal-timeout');
        assert.deepEqual(completions, ['done-1-2', 'done-2-4']); assert.equal(reads.length, 5); bounded();
        evidence.scenarios.push('hidden-same-uri-two-completions-single-watch');
    } finally {
        active = false; watch.stop();
        // Settle the session's final bounded read; its invalid token must not paint or restart.
        for (const read of reads) read.resolve(packet('playing', 99, 3));
        await flush(); watch.dispose(); trace('stopped-and-settled');
        const counts = watch.diagnostics();
        for (const key of ['watchJobs', 'watchRequests', 'progressRequests', 'retryTimers', 'progressTimers']) assert.equal(counts[key], 0);
        assert.equal(intervals.size, 0); assert.equal(timers.size, 0); assert.equal(listeners.size, 0); assert.equal(flights, 0);
        assert.equal(counts.state, 'stopped');
    }
}

run().then(() => console.log('AUDIOFLIX_SPOTIFY_WATCH_RECOVERY_OK (retry, stale reads, 50 cycles, bounded exhaustion, hidden same-uri repeat)'))
    .catch(error => {
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, JSON.stringify({ ...evidence, ok: false, node: process.version,
            failure: { message: error.message, stack: error.stack } }, null, 2));
        console.error(`AUDIOFLIX_SPOTIFY_WATCH_RECOVERY_FAIL ${evidence.phase}: ${error.message.split('\n')[0]} evidence=${artifact}`);
        process.exitCode = 1;
    });
