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
    const intervals = new Map(), timers = new Map(), reads = [], applied = [], states = [], recoveryEvents = [];
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
        applyState: result => applied.push(result), onRecovery: result => { states.push(result.state); recoveryEvents.push(result); }
    });
    const state = cursor => ({ ok: true, watchSupported: true, isOwner: true,
        engine: { eventCursor: cursor }, ownerEpoch: 1, engineEpoch: 1, trackGeneration: 1 });
    const fireTimer = async () => {
        assert.equal(timers.size, 1, 'exactly one bounded retry/recovery timer may be armed');
        const [id, job] = [...timers][0]; timers.delete(id); job.fn(); await flush();
    };
    watch.start(state(1));
    reads[0].resolve({ ok: false, timeout: true }); await flush();
    await fireTimer();
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
    // Exhaustion is finite: high-rate presentation polling stops, leaving only one low-rate
    // recovery sentinel. Degradation by itself must not repaint or retire playback.
    const terminalPoll = watch.progressOnce();
    for (let i = 0; i < 5; i++) {
        reads.at(-1).resolve({ ok: false, unavailable: true }); await flush();
        if (i < 4) await fireTimer();
    }
    assert.equal(watch.diagnostics().state, 'degraded');
    assert.equal(intervals.size, 0);
    assert.equal(watch.diagnostics().recoveryTimers, 1);
    assert.equal(timers.size, 1);
    const acceptedBefore = applied.length;
    progress[1].resolve(state(99)); await terminalPoll;
    assert.equal(applied.length, acceptedBefore, 'late poll cannot resurrect degraded observation');
    assert.equal(states.filter(value => value === 'reset').length, 0, 'degradation alone is never a reset');

    // A new helper epoch that is ownerless, idle and generation zero is authoritative playback-loss
    // evidence. It produces one reset signal and does not create a Play/Resume intent.
    await fireTimer();
    assert.equal(progress.length, 3, 'degraded recovery uses one status probe, not the normal watch/poll loop');
    const resetState = {
        ok: true, watchSupported: true, isOwner: false, ownerClientId: '',
        ownerEpoch: 2, engineEpoch: 2, trackGeneration: 0,
        managed: { helperReachable: true },
        engine: { status: 'stopped', paused: true, generation: 0, eventCursor: 0 }
    };
    progress[2].resolve(resetState); await flush();
    assert.equal(states.filter(value => value === 'reset').length, 1, 'fresh idle helper epoch signals exactly one reset');
    assert.equal(recoveryEvents.find(event => event.state === 'reset')?.result, resetState);
    assert.equal(watch.diagnostics().recoveryRequests, 0);
    assert.equal(watch.diagnostics().recoveryTimers, 0);
    assert.equal(applied.length, acceptedBefore, 'reset is retired by lifecycle; it does not repaint stale playback first');

    watch.stop(); await flush();
    assert.equal(watch.diagnostics().watchJobs, 0);
    assert.equal(watch.diagnostics().watchRequests, 0);
    assert(states.includes('reconnecting') && states.includes('degraded') && states.includes('reset'));
    evidence.scenarios.push('retry-stale-reads-rapid-start-stop-degraded-helper-reset');
    await degradedRecoveryBoundaryCases();
    await sameTrackRepeatAfterEnded();
}

async function degradedRecoveryBoundaryCases() {
    evidence.phase = 'degraded-recovery-boundaries';
    const seed = {
        ok: true, watchSupported: true, isOwner: true, ownerClientId: 'self',
        ownerEpoch: 7, engineEpoch: 7, trackGeneration: 4,
        managed: { helperReachable: true },
        engine: { status: 'playing', paused: false, generation: 4, eventCursor: 10 }
    };
    const cases = [
        {
            label: 'continued-unavailability',
            result: { ok: false, unavailable: true, managed: { helperReachable: false } },
            expect: 'degraded'
        },
        {
            label: 'same-helper-recovery',
            result: { ...seed, engine: { ...seed.engine, eventCursor: 11 } },
            expect: 'watching'
        },
        {
            label: 'another-active-owner',
            result: {
                ok: true, watchSupported: true, isOwner: false, ownerClientId: 'other-client',
                ownerEpoch: 8, engineEpoch: 8, trackGeneration: 0,
                managed: { helperReachable: true },
                engine: { status: 'playing', paused: false, generation: 0, eventCursor: 1 }
            },
            expect: 'watching'
        }
    ];

    for (const scenario of cases) {
        const timers = new Map(), intervals = new Map(), reads = [], progress = [], events = [];
        let timerId = 0, active = true;
        const remote = {
            snapshot: () => ({ connected: true }),
            send() { const read = defer(); reads.push(read); return read.promise; },
            status() { const read = defer(); progress.push(read); return read.promise; }
        };
        const window = {};
        vm.runInContext(source, vm.createContext({ window, document: { visibilityState: 'hidden' }, console,
            setInterval: fn => { intervals.set(++timerId, fn); return timerId; },
            clearInterval: id => intervals.delete(id),
            setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
            clearTimeout: id => timers.delete(id) }));
        const watch = window.EveAudioflixSpotifyStatusWatch.create({
            remote: () => remote, isActive: () => active, currentRun: () => 1,
            applyState: () => {}, onRecovery: event => events.push(event)
        });
        const fireTimer = async () => {
            assert.equal(timers.size, 1, `${scenario.label}: exactly one timer is allowed`);
            const [id, job] = [...timers][0]; timers.delete(id); job.fn(); await flush();
        };
        try {
            watch.start(seed); await flush();
            for (let i = 0; i < 5; i++) {
                reads.at(-1).resolve({ ok: false, unavailable: true }); await flush();
                if (i < 4) await fireTimer();
            }
            assert.equal(watch.diagnostics().state, 'degraded', `${scenario.label}: reaches degraded`);
            assert.equal(watch.diagnostics().recoveryTimers, 1, `${scenario.label}: one sentinel is armed`);
            assert.equal(events.filter(event => event.state === 'reset').length, 0,
                `${scenario.label}: degradation alone cannot reset`);

            await fireTimer();
            assert.equal(progress.length, 1, `${scenario.label}: one recovery status request`);
            progress[0].resolve(scenario.result); await flush();
            assert.equal(events.filter(event => event.state === 'reset').length, 0,
                `${scenario.label}: must not emit helper-reset release`);
            assert.equal(watch.diagnostics().state, scenario.expect, `${scenario.label}: expected recovery state`);

            if (scenario.expect === 'degraded') {
                assert.equal(watch.diagnostics().recoveryTimers, 1,
                    `${scenario.label}: continued outage retains exactly one sentinel`);
                assert.equal(watch.diagnostics().watchJobs, 0,
                    `${scenario.label}: continued outage does not restart normal watch`);
            } else {
                assert.equal(watch.diagnostics().recoveryTimers, 0,
                    `${scenario.label}: healthy observation cancels sentinel`);
                assert.equal(watch.diagnostics().watchJobs, 1,
                    `${scenario.label}: healthy state restarts exactly one watch`);
                assert.equal(reads.length, 6,
                    `${scenario.label}: exactly one fresh watch request is created`);
            }
            evidence.scenarios.push(`degraded-${scenario.label}-no-reset`);
        } finally {
            active = false;
            watch.stop();
            for (const read of reads) read.resolve(seed);
            for (const read of progress) read.resolve(seed);
            await flush();
            const counts = watch.diagnostics();
            for (const key of ['watchJobs', 'watchRequests', 'progressRequests', 'retryTimers',
                'progressTimers', 'recoveryRequests', 'recoveryTimers']) assert.equal(counts[key], 0, `${scenario.label}: ${key} settles`);
            assert.equal(intervals.size, 0, `${scenario.label}: intervals settle`);
            assert.equal(timers.size, 0, `${scenario.label}: timers settle`);
        }
    }
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
        assert.equal(counts.progressTimers, 1); assert.equal(counts.recoveryRequests, 0); assert.equal(counts.recoveryTimers, 0);
        assert.equal(intervals.size, 1);
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
        for (const key of ['watchJobs', 'watchRequests', 'progressRequests', 'retryTimers', 'progressTimers', 'recoveryRequests', 'recoveryTimers']) assert.equal(counts[key], 0);
        assert.equal(intervals.size, 0); assert.equal(timers.size, 0); assert.equal(listeners.size, 0); assert.equal(flights, 0);
        assert.equal(counts.state, 'stopped');
    }
}

run().then(() => console.log('AUDIOFLIX_SPOTIFY_WATCH_RECOVERY_OK (retry, stale reads, bounded degraded recovery boundaries, helper reset, hidden same-uri repeat)'))
    .catch(error => {
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, JSON.stringify({ ...evidence, ok: false, node: process.version,
            failure: { message: error.message, stack: error.stack } }, null, 2));
        console.error(`AUDIOFLIX_SPOTIFY_WATCH_RECOVERY_FAIL ${evidence.phase}: ${error.message.split('\n')[0]} evidence=${artifact}`);
        process.exitCode = 1;
    });
