'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const revision = process.argv.find(arg => arg.startsWith('--revision='))?.slice(11);
const sourcePath = 'js/modules/features/audioflix/audioflix.spotify.any-browser.js';
const source = revision ? execFileSync('git', ['show', `${revision}:${sourcePath}`], { cwd: ROOT, encoding: 'utf8' })
    : fs.readFileSync(path.join(ROOT, sourcePath), 'utf8');

const calls = [];
const windowListeners = new Map();
const dispatched = [];
const remoteSubscribers = new Set();
const spotify = {
    id: 'song-1', type: 'music', sourceProvider: 'spotify', title: 'Smoke',
    url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', volume: 0.5, duration: 180
};
let engineState = {
    status: 'playing', spotifyId: '4cOdK2wGLETKBW3PvgPWqT', generation: 1,
    currentTime: 4, duration: 180, paused: false, completionId: '', eventCursor: 1
};
let lastState = null;
let pollRemote = null;

const remote = {
    ready: true,
    subscribe(listener) { remoteSubscribers.add(listener); return () => remoteSubscribers.delete(listener); },
    notify(detail = {}) { remoteSubscribers.forEach(listener => listener({ ...remote.snapshot(), ...detail })); },
    disconnect() { remote.notify({ released: true, connected: false, status: 'unavailable' }); },
    snapshot: () => ({ connected: true, status: 'ready', approvalRequired: false, relayReady: true, lastState }),
    connect: async () => ({ connected: true, status: 'ready', relayReady: true }),
    waitUntilReady: async () => ({ connected: true }),
    openApproval: () => true,
    async status() {
        lastState = { ok: true, isOwner: true, engine: { ...engineState }, managed: { helperReachable: true } };
        return lastState;
    },
    async send(action, payload = {}, options = {}) {
        calls.push({ action, payload: { ...payload }, options: { ...options } });
        if (action === 'play' && remote.coldStartTimeouts > 0) {
            // Cold engine start: the broker keeps loading/playing after the reply window closes.
            remote.coldStartTimeouts -= 1;
            engineState = { ...engineState, status: 'playing', paused: false, spotifyId: payload.spotifyId,
                generation: engineState.generation + 1, completionId: '' };
            return { ok: false, timeout: true, reason: 'Spotify play timed out.' };
        }
        if (action === 'play') {
            engineState = {
                ...engineState, status: 'playing', paused: false,
                spotifyId: payload.spotifyId, duration: payload.duration || 180,
                generation: engineState.generation + 1
            };
        } else if (action === 'pause') engineState = { ...engineState, status: 'paused', paused: true };
        else if (action === 'resume') engineState = { ...engineState, status: 'playing', paused: false };
        else if (action === 'seek') engineState = { ...engineState, currentTime: payload.seconds };
        else if (action === 'stop') engineState = { ...engineState, status: 'stopped', paused: true, currentTime: 0 };
        lastState = { ok: true, isOwner: true, engine: { ...engineState }, managed: { helperReachable: true } };
        return lastState;
    }
};
const localizedIds = new Set();
const unavailableLocalIds = new Set();
const localPrepareCalls = [];
const localPlayback = {
    async prepare(nextItem) {
        localPrepareCalls.push(String(nextItem?.id || ''));
        if (localizedIds.has(nextItem?.id)) {
            const localPath = `C:\\Audioflix\\${nextItem.id}.mp3`;
            return { item: { ...nextItem, url: `blob:local-${nextItem.id}` }, localPath, status: '' };
        }
        if (unavailableLocalIds.has(nextItem?.id)) {
            return { item: { ...nextItem }, localPath: '', status: 'Local copy unavailable - streaming instead.' };
        }
        return { item: { ...nextItem }, localPath: '', status: '' };
    }
};
let originalPlayCount = 0;
let originalStopCount = 0;
const originalPlayCalls = [];
const stopItemCalls = [];
const audio = {
    ready: true,
    async playItem(nextItem) {
        originalPlayCount += 1;
        originalPlayCalls.push({ kind: 'play', item: { ...nextItem } });
        return true;
    },
    async openInternalView(nextItem) {
        originalPlayCount += 1;
        originalPlayCalls.push({ kind: 'internal', item: { ...nextItem } });
        return true;
    },
    async pause() { return true; },
    async seek() { return true; },
    async stopAll() { originalStopCount += 1; return true; },
    async stopItemLayers(itemId, preserveProvider = false) {
        stopItemCalls.push({ itemId: String(itemId || ''), preserveProvider: !!preserveProvider });
        return true;
    },
    updateItemVolume() {},
    getPlaybackState: () => ({ item: null, paused: true }),
    getStatus: () => ({ status: 'Idle', playback: { paused: true } })
};
const window = {
    EveAudioflixSpotifyRemote: remote,
    EveAudioflixAudio: audio,
    EveAudioflixLocalPlayback: localPlayback,
    EveAudioflixOutputPort: { effective: (value) => Number(value) * 0.5 },
    addEventListener(name, fn) { windowListeners.set(name, fn); },
    dispatchEvent(event) { dispatched.push(event); }
};
window.window = window;
const context = {
    window,
    console,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: (callback) => { pollRemote = callback; return 1; },
    clearInterval: () => {},
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    document: {
        body: { appendChild() {} },
        createElement() { return { style: {}, dataset: {}, append() {}, addEventListener() {}, remove() {} }; }
    }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.volume.js'), 'utf8'),
    context, { filename: 'audioflix.spotify.volume.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.status-watch.js'), 'utf8'),
    context, { filename: 'audioflix.spotify.status-watch.js' });
let observerOptions;
const createObserver = window.EveAudioflixSpotifyStatusWatch.create;
window.EveAudioflixSpotifyStatusWatch.create = options => { observerOptions = options; return createObserver(options); };
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.playback-lifecycle.js'), 'utf8'),
    context, { filename: 'audioflix.spotify.playback-lifecycle.js' });
vm.runInContext(source, context, { filename: 'audioflix.spotify.any-browser.js' });
let phase = 'legacy-contracts';
function evidence(error) {
    const artifact = path.join(ROOT, `data/runtime/smoke-results/audioflix-any-browser-smoke${revision ? '-' + revision.slice(0, 12) : ''}.json`);
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({ ok: !error, revision: revision || 'worktree', phase,
        error: error && { message: error.message, stack: error.stack, expected: error.expected, actual: error.actual },
        snapshot: window.EveAudioflixSpotifyAnyBrowser.snapshot(), calls, dispatched }, null, 2));
}
(async () => {
    assert.equal(window.EveAudioflixSpotifyAnyBrowser.ready, true);
    assert.equal(window.EveAudioflixSpotifyAnyBrowser.install(), false, 'ordinary-tab wrapper installs eagerly once and refuses duplicate wrapping');

    await window.EveAudioflixAudio.playItem(spotify);
    assert.equal(originalPlayCount, 0, 'managed Spotify path does not create an audible local provider player');
    assert.equal(originalStopCount, 1, 'existing local playback is stopped before managed Spotify starts');
    const play = calls.find((entry) => entry.action === 'play');
    assert.ok(play, 'ordinary tab sends play through the authorized relay client');
    assert.equal(play.payload.spotifyId, '4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(play.payload.effectiveVolume, 0.25, 'track 50% x master/output 50% reaches the engine as exactly 25% once');
    assert.equal(play.options.timeout, 45000, 'staged managed Play keeps a reply budget above the old 20s browser timeout race');

    window.EveAudioflixAudio.updateItemVolume('song-1', 0.4);
    await Promise.resolve();
    const slider = calls.filter((entry) => entry.action === 'volume').at(-1);
    assert.equal(slider.payload.effectiveVolume, 0.2, 'track slider sends one already-effective gain to the engine');

    windowListeners.get('eve:audioflix-output-volume')?.();
    await Promise.resolve();
    const master = calls.filter((entry) => entry.action === 'volume').at(-1);
    assert.equal(master.payload.effectiveVolume, 0.2, 'master sync starts from saved raw track gain and does not double-attenuate');

    await window.EveAudioflixAudio.pause();
    assert.equal(calls.at(-1).action, 'pause');
    await window.EveAudioflixAudio.seek(42);
    assert.equal(calls.at(-1).action, 'seek');
    assert.equal(calls.at(-1).payload.seconds, 42);

    // If another tab took ownership of the same item, clicking Play here must deliberately transfer
    // ownership rather than silently returning or trying an observer-only resume.
    lastState = { ok: true, isOwner: false, engine: { ...engineState }, managed: { helperReachable: true } };
    const playsBeforeTransfer = calls.filter((entry) => entry.action === 'play').length;
    await window.EveAudioflixAudio.playItem(spotify);
    assert.equal(calls.filter((entry) => entry.action === 'play').length, playsBeforeTransfer + 1, 'explicit Play on an observed same item transfers ownership through a fresh play command');

    const stopsBeforeCard = calls.filter((entry) => entry.action === 'stop').length;
    await window.EveAudioflixAudio.stopItemLayers('song-1', false);
    assert.equal(calls.filter((entry) => entry.action === 'stop').length, stopsBeforeCard + 1, 'card Stop for the active managed Spotify item sends broker stop');
    assert.deepEqual(stopItemCalls.at(-1), { itemId: 'song-1', preserveProvider: false }, 'card Stop still runs the original item-layer cleanup');

    await window.EveAudioflixAudio.playItem(spotify);
    const stopsBeforePreserve = calls.filter((entry) => entry.action === 'stop').length;
    await window.EveAudioflixAudio.stopItemLayers('song-1', true);
    assert.equal(calls.filter((entry) => entry.action === 'stop').length, stopsBeforePreserve, 'preserveProvider=true does not stop the managed Spotify engine during provider replay');
    assert.deepEqual(stopItemCalls.at(-1), { itemId: 'song-1', preserveProvider: true }, 'preserve-provider cleanup still delegates to the original layer stop');

    // A Spotify identity is not a command to use Spotify if the item has a reachable local copy.
    // The local resolver is authoritative because it validates the saved path/handle before routing.
    localizedIds.add('song-1');
    const remotePlaysBeforeLocal = calls.filter((entry) => entry.action === 'play').length;
    const remoteStopsBeforeLocal = calls.filter((entry) => entry.action === 'stop').length;
    const originalBeforeLocal = originalPlayCount;
    await window.EveAudioflixAudio.playItem({ ...spotify, localPath: 'C:\\Audioflix\\song-1.mp3' });
    assert.equal(originalPlayCount, originalBeforeLocal + 1, 'reachable localized Spotify item delegates to the ordinary local playback path');
    assert.equal(calls.filter((entry) => entry.action === 'play').length, remotePlaysBeforeLocal, 'localized Spotify item does not send a managed Spotify play command');
    assert.equal(calls.filter((entry) => entry.action === 'stop').length, remoteStopsBeforeLocal + 1, 'switching an active Spotify engine to its local copy stops only managed Spotify playback first');
    assert.equal(originalPlayCalls.at(-1).kind, 'play');
    assert.equal(originalPlayCalls.at(-1).item.url, 'blob:local-song-1', 'validated local media source reaches the existing Audioflix local playback pipeline');
    assert.equal(window.EveAudioflixSpotifyAnyBrowser.snapshot().active, false, 'localized playback leaves the managed Spotify route inactive');
    localizedIds.delete('song-1');

    localizedIds.add('song-local-view');
    const internalBefore = originalPlayCount;
    const managedPlaysBeforeInternal = calls.filter((entry) => entry.action === 'play').length;
    await window.EveAudioflixAudio.openInternalView({ ...spotify, id: 'song-local-view', localPath: 'C:\\Audioflix\\song-local-view.mp3' });
    assert.equal(originalPlayCount, internalBefore + 1);
    assert.equal(originalPlayCalls.at(-1).kind, 'internal', 'Internal View also keeps a localized Spotify-linked item on the local path');
    assert.equal(calls.filter((entry) => entry.action === 'play').length, managedPlaysBeforeInternal, 'localized Internal View does not wake the managed Spotify engine');
    localizedIds.delete('song-local-view');

    unavailableLocalIds.add('song-missing-local');
    const originalBeforeMissing = originalPlayCount;
    const remoteBeforeMissing = calls.filter((entry) => entry.action === 'play').length;
    await window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-missing-local', localPath: 'C:\\Audioflix\\missing.mp3' });
    assert.equal(originalPlayCount, originalBeforeMissing, 'an unreachable saved local path does not force a broken local playback attempt');
    assert.equal(calls.filter((entry) => entry.action === 'play').length, remoteBeforeMissing + 1, 'unreachable local copy safely falls back to managed Spotify');
    unavailableLocalIds.delete('song-missing-local');
    assert.ok(localPrepareCalls.includes('song-1') && localPrepareCalls.includes('song-missing-local'), 'Spotify routing asks the normal local resolver before choosing the provider path');

    // First queue track on a cold engine: the play reply times out while the engine is still
    // starting. The client must adopt that playback (active + polled) or #1 never reports Ended.
    await window.EveAudioflixAudio.stopAll();
    remote.coldStartTimeouts = 1;
    const coldItem = { ...spotify, id: 'song-cold', url: 'https://open.spotify.com/track/1AbCdEfGhIjKlMnOpQrStU' };
    assert.equal(await window.EveAudioflixAudio.playItem(coldItem), true, 'a timed-out cold-start play is adopted once the engine reports it playing for this client');
    const coldSnapshot = window.EveAudioflixSpotifyAnyBrowser.snapshot();
    assert.equal(coldSnapshot.active, true, 'adopted cold-start playback is the active managed route');
    assert.equal(coldSnapshot.item.id, 'song-cold');
    // Slow status must never accumulate overlapping requests or relabel an old terminal
    // snapshot as the next queue item. The managed browser is a separate async runtime.
    const normalStatus = remote.status;
    let releaseStatus, statusCalls = 0;
    const oldSnapshot = { ok: true, isOwner: true, engine: {
        ...engineState, status: 'ended', ended: true, completionId: 'stale-poll:1'
    }};
    remote.status = () => { statusCalls += 1; return new Promise(resolve => { releaseStatus = resolve; }); };
    await Promise.resolve();
    pollRemote(); pollRemote();
    assert.equal(statusCalls, 1, 'slow managed status remains single-flight, not a growing timer backlog');
    const oldCompletions = dispatched.filter(event => event.detail?.status === 'Ended').length;
    remote.status = normalStatus;
    await window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-new-run' });
    releaseStatus(oldSnapshot);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(dispatched.filter(event => event.detail?.status === 'Ended').length, oldCompletions, 'late old-track status cannot consume completion for the replacement track');
    await window.EveAudioflixAudio.playItem(coldItem);
    engineState = { ...engineState, status: 'ended', paused: true, completionId: 'cold:1' };
    await remote.status();
    const endedBefore = dispatched.filter((event) => event.detail?.status === 'Ended').length;
    await window.EveAudioflixAudio.seek(1);
    assert.ok(dispatched.filter((event) => event.detail?.status === 'Ended' && event.detail?.item?.id === 'song-cold').length > endedBefore, 'the adopted first track reports Ended so the existing queue can advance');

    // An already-running engine can retain completion while its status says paused after a reset.
    await window.EveAudioflixAudio.stopAll();
    await window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-terminal' });
    const countCompletions = () => dispatched.filter((event) => event.detail?.status === 'Ended').length;
    const poll = async () => { pollRemote(); await Promise.resolve(); await Promise.resolve(); };
    const completionsBeforeReset = countCompletions();
    const resumesBeforeReset = calls.filter((entry) => entry.action === 'resume').length;
    engineState = { ...engineState, status: 'paused', paused: true, ended: false,
        currentTime: 46, completionId: 'terminal:1' };
    await poll();
    assert.equal(countCompletions(), completionsBeforeReset, 'paused state without a terminal latch does not consume a completion ID alone');
    assert.equal(calls.filter((entry) => entry.action === 'resume').length, resumesBeforeReset, 'polling a mid-track pause never automatically resumes Spotify');
    engineState = { ...engineState, ended: true, currentTime: 0 };
    await poll();
    assert.equal(countCompletions(), completionsBeforeReset + 1, 'paused state with a durable terminal latch reports completion once');
    assert.equal(dispatched.filter((event) => event.detail?.status === 'Ended').at(-1).detail.item.id, 'song-terminal', 'durable completion keeps the active track identity');
    await poll();
    assert.equal(countCompletions(), completionsBeforeReset + 1, 'duplicate paused terminal snapshots cannot emit another Ended event');

    phase = 'explicit-release';
    const managed = window.EveAudioflixSpotifyAnyBrowser, A = window.EveAudioflixAudio;
    const count = action => calls.filter(entry => entry.action === action).length;
    const eventCount = status => dispatched.filter(event => event.detail?.status === status).length;
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const assertRetired = async (id, endedCount, stoppedCount) => {
        await settle(); const s = managed.snapshot();
        assert.equal(s.active, false, `${id}: explicit release retires active managed playback`);
        assert.equal(s.playback.paused, true, `${id}: released local playback is paused`);
        for (const key of ['watchJobs', 'watchRequests', 'progressRequests', 'progressTimers', 'retryTimers'])
            assert.equal(s.observation[key], 0, `${id}: ${key} settles without closing the page`);
        assert.equal(eventCount('Stopped'), stoppedCount + 1, `${id}: release emits exactly one Stopped`);
        const stopDetail = dispatched.filter(event => event.detail?.status === 'Stopped').at(-1).detail;
        assert.equal(stopDetail.released, true, `${id}: explicit release is distinguishable from ordinary Stop`);
        assert.equal(stopDetail.item?.id, s.playback.item?.id, `${id}: release retains stopped identity for the queue owner`);
        assert.equal(eventCount('Ended'), endedCount, `${id}: release never advances via Ended`);
    };
    await A.stopAll(); engineState = { ...engineState, ended: false, completionId: '' };
    const releaseItem = { ...spotify, id: 'song-release' };
    await A.playItem(releaseItem); const playsBeforeRelease = count('play');
    for (const status of ['ready', 'retrying', 'unavailable']) remote.notify({ status, connected: status === 'ready' });
    observerOptions.onRecovery({ state: 'degraded' });
    assert.equal(managed.snapshot().active, true, 'generic readiness/retry/degradation never implies explicit release');
    assert.equal(count('play'), playsBeforeRelease, 'status notifications never create autoplay');
    const endedBeforeRelease = eventCount('Ended'), stoppedBeforeRelease = eventCount('Stopped');
    remote.disconnect(); await assertRetired('active-release', endedBeforeRelease, stoppedBeforeRelease);
    remote.notify({ status: 'ready', connected: true }); await settle();
    assert.equal(managed.snapshot().active, false, 'retry after release cannot restore playback without explicit Play');
    assert.equal(count('play'), playsBeforeRelease, 'release/retry cannot send another Play');
    await A.playItem(releaseItem);
    assert.equal(count('play'), playsBeforeRelease + 1, 'explicit replay acquires a fresh managed Play');
    assert.equal(managed.snapshot().active, true); assert.equal(managed.snapshot().playback.paused, false);
    assert.equal(remoteSubscribers.size, 1, 'all playback runs share one explicit-release subscription');
    await A.stopAll();
    const normalSend = remote.send; let finishReleasedStart;
    remote.send = async (action, payload, options) => action !== 'play' ? normalSend(action, payload, options)
        : new Promise(resolve => { calls.push({ action, payload, options }); finishReleasedStart = resolve; });
    const releasedStart = A.playItem({ ...spotify, id: 'song-released-start' });
    await settle(); assert.equal(typeof finishReleasedStart, 'function', 'release regression holds an actual Play in flight');
    const endedBeforeStartRelease = eventCount('Ended'), stoppedBeforeStartRelease = eventCount('Stopped');
    const playsBeforeStartRelease = count('play');
    remote.disconnect(); await assertRetired('starting-release', endedBeforeStartRelease, stoppedBeforeStartRelease);
    finishReleasedStart({ ok: true, isOwner: true, engine: { ...engineState, status: 'playing', paused: false, ended: false, completionId: '' } });
    assert.equal(await releasedStart, false, 'released in-flight Play ignores even a late successful reply');
    remote.send = normalSend; remote.notify({ status: 'ready', connected: true }); await settle();
    assert.equal(managed.snapshot().active, false); assert.equal(count('play'), playsBeforeStartRelease);
    assert.equal(eventCount('Ended'), endedBeforeStartRelease, 'late successful Play cannot manufacture completion');
    assert.equal(eventCount('Stopped'), stoppedBeforeStartRelease + 1, 'late reply cannot emit duplicate Stop');
    await A.playItem(releaseItem); assert.equal(managed.snapshot().active, true, 'explicit replay also recovers a released start');
    phase = 'legacy-contracts';

    assert.match(source, /completionId/);
    assert.match(source, /emitPlayback\('Ended'\)/);
    assert.match(source, /preferredLocalItem/, 'managed Spotify wrapper explicitly gives validated local playback first refusal');
    assert.match(source, /fallback:\s*!relayWasReached\(\)/, 'fallback is permitted only before a trusted relay handshake has been reached');
    assert.doesNotMatch(source, /__EveAudioflixManagedBrowserSession/, 'ordinary-tab client does not depend on the old injected managed-session marker');

    // Stop the managed route, then prove option (b): if no relay/server ever answers, the legacy
    // official embed remains available. Once a relay has answered, an ambiguous failure stays
    // fail-closed so EveOS cannot create a second audible Spotify source.
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

    // A thrown remote start must not leave the provider stuck in `starting`, and an older run's
    // late failure must never clear a newer run's start.
    {
        await window.EveAudioflixAudio.stopAll();
        const realSend = remote.send;
        const count = action => calls.filter(entry => entry.action === action).length;
        remote.send = async (action, payload = {}, options = {}) => {
            if (action !== 'play') return realSend(action, payload, options);
            calls.push({ action, payload: { ...payload }, options: { ...options } });
            throw new Error('relay dropped');
        };
        await assert.rejects(() => window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-throw' }), /relay dropped/);
        const pausesBefore = count('pause'), stopsBefore = count('stop'), localStopsBefore = originalStopCount;
        await window.EveAudioflixAudio.pause();
        await window.EveAudioflixAudio.stopAll();
        assert.equal(count('pause'), pausesBefore, 'Pause after a failed start routes to the local player');
        assert.equal(count('stop'), stopsBefore, 'Stop after a failed start does not hit the broker');
        assert.equal(originalStopCount, localStopsBefore + 1, 'Stop after a failed start reaches the local player');
        const localBefore = originalPlayCount;
        await window.EveAudioflixAudio.playItem({ id: 'local-after-throw', url: 'https://example.com/b.mp3', sourceProvider: 'direct' });
        assert.equal(originalPlayCount, localBefore + 1, 'local playback after a failed start is normal');

        const pending = new Map();
        remote.send = async (action, payload = {}, options = {}) => {
            if (action !== 'play') return realSend(action, payload, options);
            calls.push({ action, payload: { ...payload }, options: { ...options } });
            return new Promise((resolve, reject) => pending.set(payload.spotifyId, { resolve, reject }));
        };
        const runA = window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-a', url: 'https://open.spotify.com/track/1111111111111111111111' });
        await new Promise(resolve => setTimeout(resolve, 20));
        const runB = window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-b', url: 'https://open.spotify.com/track/2222222222222222222222' });
        await new Promise(resolve => setTimeout(resolve, 20));
        pending.get('1111111111111111111111').reject(new Error('late A failure'));
        assert.equal(await runA, false, 'a superseded run failing late is cancellation, not a skip');
        const pausesBeforeB = count('pause');
        await window.EveAudioflixAudio.pause();
        assert.equal(count('pause'), pausesBeforeB + 1, "A's late failure did not clear B's starting state");
        pending.get('2222222222222222222222').resolve({ ok: false, lifecycle: 'paused', superseded: true });
        assert.equal(await runB, false);
        remote.send = realSend;
    }

    await window.EveAudioflixAudio.stopAll();
    remote.connect = async () => { throw new Error('relay offline'); };
    remote.snapshot = () => ({ connected: false, status: 'unavailable', approvalRequired: false, relayReady: false, lastState: null });
    const fallbackBefore = originalPlayCount;
    await window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-fallback' });
    assert.equal(originalPlayCount, fallbackBefore + 1, 'an absent/unreachable relay falls back to the existing official Spotify embed');

    remote.connect = async () => { throw new Error('relay answered, command failed'); };
    remote.snapshot = () => ({ connected: false, status: 'unavailable', approvalRequired: false, relayReady: true, lastState: null });
    const failClosedBefore = originalPlayCount;
    await assert.rejects(
        () => window.EveAudioflixAudio.playItem({ ...spotify, id: 'song-fail-closed' }),
        /relay answered, command failed/
    );
    assert.equal(originalPlayCount, failClosedBefore, 'after a trusted relay handshake an ambiguous failure does not start a second local embed');

    const local = { id: 'local-1', url: 'https://example.com/audio.mp3', sourceProvider: 'direct' };
    const localBefore = originalPlayCount;
    await window.EveAudioflixAudio.playItem(local);
    assert.equal(originalPlayCount, localBefore + 1, 'non-Spotify playback remains on the existing local/browser path');

    assert.ok(dispatched.some((event) => event.type === 'eve:audioflix-progress'), 'remote Spotify state feeds the existing public Audioflix progress channel');
    phase = 'complete'; evidence(); console.log('AUDIOFLIX_SPOTIFY_ANY_BROWSER_SMOKE_OK');
})().catch((error) => {
    evidence(error); console.error(`AUDIOFLIX_SPOTIFY_ANY_BROWSER_SMOKE_FAIL ${phase}`);
    console.error(String(error.stack || error).split('\n').slice(0, 38).join('\n')); process.exitCode = 1;
});
