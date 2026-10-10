export function normalizeSpotify(value) {
    const raw = String(value || '').trim();
    if (/^[A-Za-z0-9]{22}$/.test(raw)) return `https://open.spotify.com/track/${raw}`;
    const id = raw.match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)([A-Za-z0-9]{22})/i)?.[1];
    return id ? `https://open.spotify.com/track/${id}` : '';
}

export function spotifyTrackId(value) {
    return normalizeSpotify(value).match(/\/track\/([A-Za-z0-9]{22})/i)?.[1] || '';
}

export function createLongQueueHarness({
    base, controllerUrl, engineUrl, groupName, fixturePrefix,
    transitionTimeout, tailSeconds, shouldStart, takeOver
}) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const canonicalUrl = (raw) => {
        try {
            const url = new URL(String(raw || ''));
            url.hash = '';
            return url.href.replace(/\/$/, '');
        } catch { return ''; }
    };
    const assert = (condition, message) => {
        if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
    };
    async function jsonRequest(path, method = 'GET', body = null) {
        let response;
        try {
            response = await fetch(`${base}${path}`, {
                method,
                headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
                body: body ? JSON.stringify(body) : undefined
            });
        } catch (error) {
            throw new Error(`EveOS server not reachable at ${base}: ${error?.message || error}`);
        }
        let payload = {};
        try { payload = await response.json(); } catch {}
        if (!response.ok) throw new Error(payload.reason || payload.message || `HTTP ${response.status}`);
        return payload;
    }
    async function pollNode(check, timeout = transitionTimeout, interval = 120) {
        const deadline = Date.now() + timeout;
        let last;
        while (Date.now() < deadline) {
            last = await check();
            if (last?.ok) return last.value;
            await sleep(interval);
        }
        throw new Error(last?.reason || `Timed out after ${timeout}ms.`);
    }
    function validateUrls() {
        const controller = new URL(controllerUrl);
        const engine = new URL(engineUrl);
        const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);
        if (!allowedHosts.has(controller.hostname) || !allowedHosts.has(engine.hostname)) {
            throw new Error('Live queue proof requires loopback controller and engine URLs.');
        }
        if (!/\/EveOS\.html$/i.test(controller.pathname)) {
            throw new Error(`Controller must be EveOS.html, got ${controllerUrl}`);
        }
        if (!/\/audioflix-spotify-engine\.html$/i.test(engine.pathname)) {
            throw new Error(`Managed provider must be audioflix-spotify-engine.html, got ${engineUrl}`);
        }
        if (canonicalUrl(controllerUrl) === canonicalUrl(engineUrl)) {
            throw new Error('Controller and managed Spotify engine must be different pages.');
        }
    }
    const statusTracks = (status) => [...new Set((Array.isArray(status?.trackIds) ? status.trackIds : [])
        .map((id) => String(id || '')).filter(Boolean))];
    const statusHasPlayback = (status) => {
        const state = String(status?.state || '').toLowerCase();
        return Number(status?.playingCount || 0) > 0 || statusTracks(status).length > 0
            || ['playing', 'starting', 'controlling', 'provider-paused'].includes(state);
    };
    async function observeIdleWindow(initial, windowMs = 5000) {
        let status = initial;
        const deadline = Date.now() + windowMs;
        while (Date.now() < deadline) {
            if (statusHasPlayback(status)) return { idle: false, status };
            await sleep(250);
            status = await jsonRequest('/api/audioflix/spotify-browser/status');
        }
        return { idle: !statusHasPlayback(status), status };
    }
    function competingPlaybackError(status) {
        const tracks = statusTracks(status);
        return `Another EveOS controller is using managed Spotify playback`
            + `${tracks.length ? ` (${tracks.join(', ')})` : ''}. Stop it first, or explicitly use --take-over; `
            + '--take-over intentionally stops the current managed Spotify playback.';
    }
    async function ensureManagedEngine() {
        let status = await jsonRequest('/api/audioflix/spotify-browser/status');
        const expected = canonicalUrl(engineUrl);
        let actual = canonicalUrl(status.pageUrl);
        let running = status.browserRunning || status.helperReachable;
        let wrongPage = running && actual !== expected;
        if (wrongPage && !shouldStart && !takeOver) {
            throw new Error(
                `Managed Spotify helper is attached to ${status.pageUrl || '(unknown page)'}, expected ${engineUrl}. `
                + 'Stop it and start the engine page, or re-run with --start.'
            );
        }
        if (wrongPage && (shouldStart || takeOver)) {
            await jsonRequest('/api/audioflix/spotify-browser/stop', 'POST', {});
            await sleep(250);
            status = await jsonRequest('/api/audioflix/spotify-browser/status');
        }
        if (status.helperReachable && canonicalUrl(status.pageUrl) === expected) {
            const observed = await observeIdleWindow(status);
            if (observed.idle) return { status: observed.status, startedBySmoke: false };
            if (!takeOver) throw new Error(competingPlaybackError(observed.status));
            console.warn('LIVE_QUEUE_TAKE_OVER stopping existing managed Spotify playback before qualification.');
            await jsonRequest('/api/audioflix/spotify-browser/stop', 'POST', {});
            await sleep(250);
            status = await jsonRequest('/api/audioflix/spotify-browser/status');
        }
        if (!shouldStart && !takeOver) {
            throw new Error(`Managed Spotify engine is not ready on ${engineUrl}. Start it first or pass --start.`);
        }
        const started = await jsonRequest('/api/audioflix/spotify-browser/start', 'POST', { pageUrl: engineUrl });
        assert(started.ok, started.reason || 'managed Spotify browser did not start');
        assert(started.helperReachable === true, `managed Spotify helper is not reachable after start: ${JSON.stringify(started)}`);
        assert(canonicalUrl(started.pageUrl) === expected,
            `managed Spotify helper started the wrong page: ${started.pageUrl || '(empty)'}; expected ${engineUrl}`);
        const observed = await observeIdleWindow(started);
        assert(observed.idle, `managed Spotify engine was not stably idle after startup: ${JSON.stringify(observed.status)}`);
        return { status: observed.status, startedBySmoke: true };
    }
    async function engineStatus(expectedTrackId = '', phase = 'playback') {
        const status = await jsonRequest('/api/audioflix/spotify-browser/status');
        const tracks = statusTracks(status);
        if (expectedTrackId && tracks.length && !tracks.includes(expectedTrackId)) {
            throw new Error(`engine is playing ${tracks.join(', ')}, not fixture ${expectedTrackId} during ${phase}`);
        }
        return { status, tracks, matches: !expectedTrackId || tracks.includes(expectedTrackId) };
    }
    async function queueSnapshot(page) {
        return page.evaluate(() => {
            const q = window.EveAudioflix?.queueConnection?.snapshot?.();
            const managed = window.EveAudioflixSpotifyAnyBrowser?.snapshot?.();
            const lastState = managed?.relay?.lastState || {};
            return {
                queue: q ? JSON.parse(JSON.stringify(q)) : null,
                managed: managed ? {
                    active: managed.active === true,
                    ended: managed.ended === true,
                    playback: managed.playback ? {
                        paused: managed.playback.paused === true,
                        duration: Number(managed.playback.duration || 0),
                        currentTime: Number(managed.playback.currentTime || 0)
                    } : null,
                    ownership: {
                        isOwner: lastState.isOwner === true,
                        ownerEpoch: Number(lastState.ownerEpoch || 0),
                        engineEpoch: Number(lastState.engineEpoch || 0),
                        trackGeneration: Number(lastState.trackGeneration || 0),
                        ownerClientId: String(lastState.ownerClientId || '')
                    }
                } : null,
                visibility: document.visibilityState
            };
        });
    }
    function assertFixtureQueue(snapshot, expectedIds, index = null) {
        const queue = snapshot?.queue;
        assert(queue, 'queue snapshot is unavailable');
        assert(queue.groupName === groupName,
            `controller attached to unexpected queue "${queue.groupName || '(none)'}"; expected "${groupName}"`);
        assert(queue.entries?.length === expectedIds.length,
            `fixture queue has ${queue.entries?.length || 0} entries; expected ${expectedIds.length}`);
        const actualIds = (queue.entries || []).map((entry) => String(entry.id || ''));
        assert(actualIds.every((id) => id.startsWith(fixturePrefix)),
            `fixture identity lost; non-test queue ids observed: ${actualIds.filter((id) => !id.startsWith(fixturePrefix)).join(', ')}`);
        assert(actualIds.every((id, position) => id === expectedIds[position]),
            `fixture order changed unexpectedly: ${JSON.stringify(actualIds)}`);
        if (index != null) assert(queue.currentIndex === index,
            `fixture currentIndex=${queue.currentIndex}; expected ${index}`);
    }
    async function waitForFixtureQueue(page, expectedIds) {
        return pollNode(async () => {
            const snapshot = await queueSnapshot(page);
            const ids = (snapshot.queue?.entries || []).map((entry) => String(entry.id || ''));
            const ok = snapshot.queue?.isPlaying === true
                && snapshot.queue.groupName === groupName
                && snapshot.queue.currentIndex === 0
                && ids.length === expectedIds.length
                && ids.every((id, index) => id === expectedIds[index]);
            return { ok, value: snapshot, reason: `temporary queue did not become authoritative; last=${JSON.stringify(snapshot)}` };
        });
    }
    async function waitForOwnership(page, expectedIds) {
        return pollNode(async () => {
            const snapshot = await queueSnapshot(page);
            assertFixtureQueue(snapshot, expectedIds, 0);
            const ownership = snapshot.managed?.ownership;
            const ok = ownership?.isOwner === true && Number(ownership.ownerEpoch || 0) > 0;
            return { ok, value: ownership, reason: `controller never became Spotify owner; last=${JSON.stringify(ownership)}` };
        }, transitionTimeout, 120);
    }
    async function waitForTrackReady(page, index, expectedIds, ownerEpoch, expectedTrackId) {
        const snapshot = await pollNode(async () => {
            const value = await queueSnapshot(page);
            assertFixtureQueue(value, expectedIds, index);
            const ownership = value.managed?.ownership;
            if (ownerEpoch) {
                assert(ownership?.isOwner === true, `controller lost Spotify ownership at queue index ${index}`);
                assert(Number(ownership.ownerEpoch || 0) === ownerEpoch,
                    `Spotify ownership epoch changed from ${ownerEpoch} to ${ownership?.ownerEpoch || 0} at queue index ${index}`);
            }
            const actual = await engineStatus(expectedTrackId, `queue index ${index} readiness`);
            const ready = value.queue?.isPlaying === true
                && value.managed?.active === true && value.managed.playback?.paused === false
                && Number(value.managed.playback?.duration || 0) > 5 && actual.matches;
            return { ok: ready, value, reason: `track ${index + 1} did not become ready; engine=${JSON.stringify(actual.status)} controller=${JSON.stringify(value)}` };
        });
        return {
            currentIndex: snapshot.queue.currentIndex,
            itemId: snapshot.queue.entries?.[snapshot.queue.currentIndex]?.id || '',
            title: snapshot.queue.entries?.[snapshot.queue.currentIndex]?.title || '',
            duration: snapshot.managed.playback.duration,
            currentTime: snapshot.managed.playback.currentTime
        };
    }
    async function waitForManagedPlayback(expectedTrackId) {
        return pollNode(async () => {
            const actual = await engineStatus(expectedTrackId, 'managed playback confirmation')
                .catch((error) => ({ status: { ok: false, reason: error.message }, tracks: [], matches: false }));
            if (actual.status?.reason?.startsWith?.('engine is playing ')) throw new Error(actual.status.reason);
            const status = actual.status || {};
            const ready = status.ok && status.helperReachable && status.sessionPresent
                && canonicalUrl(status.pageUrl) === canonicalUrl(engineUrl)
                && Number(status.playingCount || 0) >= 1 && actual.matches;
            return { ok: ready, value: status, reason: `managed Spotify helper never reached fixture playback; last=${JSON.stringify(status)}` };
        }, transitionTimeout, 250);
    }
    async function waitForSeekLanding(page, index, expectedIds, ownerEpoch, duration, expectedTrackId) {
        const threshold = Math.max(0, Number(duration || 0) - tailSeconds - 1);
        return pollNode(async () => {
            const snapshot = await queueSnapshot(page);
            if (snapshot.queue?.currentIndex === index + 1 && index < expectedIds.length - 1) {
                assertFixtureQueue(snapshot, expectedIds, index + 1);
                return { ok: true, value: { snapshot, advanced: true } };
            }
            assertFixtureQueue(snapshot, expectedIds, index);
            const ownership = snapshot.managed?.ownership;
            assert(ownership?.isOwner === true && Number(ownership.ownerEpoch || 0) === ownerEpoch,
                `Spotify ownership changed while seeking queue index ${index}`);
            const actual = await engineStatus(expectedTrackId, `queue index ${index} seek`);
            const currentTime = Number(snapshot.managed?.playback?.currentTime || 0);
            return {
                ok: actual.matches && currentTime >= threshold,
                value: { snapshot, advanced: false },
                reason: `seek did not reach fixture engine track for queue index ${index}; currentTime=${currentTime.toFixed(3)}, threshold=${threshold.toFixed(3)}, engine=${JSON.stringify(actual.status)}`
            };
        }, Math.min(8000, transitionTimeout), 75);
    }
    return {
        sleep, assert, jsonRequest, pollNode, validateUrls, ensureManagedEngine, queueSnapshot,
        assertFixtureQueue, waitForFixtureQueue, waitForOwnership, waitForTrackReady,
        waitForManagedPlayback, waitForSeekLanding
    };
}
