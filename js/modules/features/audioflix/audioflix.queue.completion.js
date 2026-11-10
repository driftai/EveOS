window.EveAudioflixQueueCompletion = window.EveAudioflixQueueCompletion || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixQueueCompletion;
    if (ns.ready) return;

    // Each Ended callback object is claimed by the playbackRunId it completed. Repeat-one keeps the
    // same entry across runs, so the (entry, run) key alone would accept a late re-delivery of an
    // already consumed callback as a fresh completion of the restarted run.
    const claims = new WeakMap();
    const isStaleDelivery = (detail, run) => !!detail && typeof detail === 'object'
        && claims.has(detail) && claims.get(detail) !== run;

    // The internal queue used to rebuild its whole <ol> on every sync, including progress-driven
    // no-op syncs. Replacing the hovered button between pointerdown/pointerup caused visible flicker
    // and lost queue-jump clicks. This wrapper is installed before Audioflix URL playback creates
    // its controller and lets semantic queue changes through while preserving DOM nodes on no-ops.
    function queueViewSignature(entries, currentIndex) {
        const list = Array.isArray(entries) ? entries : [];
        const repeatOne = window.EveAudioflix?.queueConnection?.snapshot?.()?.repeatOne === true;
        return JSON.stringify([
            Number(currentIndex) || 0,
            repeatOne,
            list.map((entry) => [String(entry?.id ?? ''), String(entry?.title || 'Untitled')])
        ]);
    }

    function queueViewState(stage) {
        return !stage ? 'unmounted' : JSON.stringify([stage.hidden,
            stage.classList.contains('is-transport-only'), stage.classList.contains('is-collapsed'),
            stage.querySelector('.audioflix-provider-queue-list')?.childElementCount || 0]);
    }

    function installStableQueueView() {
        const player = window.EveAudioflixInternalPlayer;
        if (!player?.createController) return false;
        if (player.__eveStableQueueViewInstalled) return true;
        const originalCreate = player.createController;
        player.createController = function createStableQueueController(options) {
            const controller = originalCreate.call(player, options);
            if (!controller?.setQueue) return controller;
            const renderQueue = controller.setQueue.bind(controller);
            let lastSignature = null;
            let lastViewState = null;
            controller.setQueue = (entries, currentIndex) => {
                const signature = queueViewSignature(entries, currentIndex);
                const viewState = queueViewState(controller.getStage?.());
                if (signature === lastSignature && viewState === lastViewState) return false;
                renderQueue(entries, currentIndex);
                lastSignature = signature;
                lastViewState = queueViewState(controller.getStage?.());
                return true;
            };
            return controller;
        };
        player.__eveStableQueueViewInstalled = true;
        return true;
    }

    installStableQueueView();

    function patchTerminalTransport() {
        const overlay = document.querySelector?.('#audioflix-overlay');
        if (!overlay) return 0;
        const stopButtons = overlay.querySelectorAll?.('[data-af-action="stop-music-group"]') || [];
        let changed = 0;
        stopButtons.forEach((button) => {
            button.dataset.afAction = 'play-music-group';
            button.classList?.remove?.('is-active');
            button.textContent = '▶ Play Group';
            changed += 1;
        });
        return changed;
    }

    function syncTerminalView(snapshot) {
        const latest = snapshot?.();
        if (latest?.isPlaying) return false;
        window.EveAudioflixAudio?.syncQueueView?.();
        // Terminal state is transport state, not a structural library change. Patch the live group
        // button in place so natural exhaustion/skip-past-end cannot replace cards, steal focus, or
        // jump a deeply scrolled library just to turn "Stop Group" back into "Play Group".
        const patched = patchTerminalTransport();
        window.EveAudioflixDiagnostics?.increment?.('queue:terminal-patches', patched);
        return true;
    }

    function create({ snapshot, advance, restart }) {
        let consumed = '';
        return function complete(detail = {}) {
            const queue = snapshot();
            const entry = queue?.entries?.[queue.currentIndex];
            // Only definitive transport errors may skip a track. Transient provider warnings,
            // buffering, user Pause and ambiguous Engine failures remain under their owners.
            const terminalFailure = detail.error === true && detail.terminal === true;
            if ((detail.status !== 'Ended' && !terminalFailure) || !queue?.isPlaying || !entry) return false;
            const id = String(entry.id ?? '');
            if (detail.item?.id != null && String(detail.item.id) !== id) return false;
            const run = queue.playbackRunId;
            const key = `${id}:${run}`;
            if (consumed === key || isStaleDelivery(detail, run)) return false;
            consumed = key;
            if (typeof detail === 'object') claims.set(detail, run);
            Promise.resolve(detail.settle).catch(() => false).then(async () => {
                const latest = snapshot();
                if (!latest?.isPlaying || latest.playbackRunId !== run
                    || String(latest.entries?.[latest.currentIndex]?.id ?? '') !== id) return;
                // A broken item must advance even when repeat-one is enabled, or it would loop forever.
                await (terminalFailure ? advance() : latest.repeatOne ? restart() : advance());
                syncTerminalView(snapshot);
            }).catch(error => {
                window.EveAudioflixDiagnostics?.record?.('queue:completion-error', 0, { error: true });
                console.warn('[Audioflix] Queue completion failed:', error?.message || error);
            });
            return true;
        };
    }

    function createBridge({ state, queue, playIndex }) {
        const trackAt = (index) => {
            const active = queue();
            const view = window.EveAudioflixLibraryIndex?.get?.(state(), 'music');
            return view ? view.getById(active.items[index]) : (state().music || []).find((track) => track.id === active.items[index]);
        };
        const entries = () => {
            const view = window.EveAudioflixLibraryIndex?.get?.(state(), 'music');
            if (view) return queue().items.map(id => ({ id, title: view.getById(id)?.title || 'Untitled' }));
            const tracks = new Map((state().music || []).map((track) => [track.id, track]));
            return queue().items.map((id) => ({ id, title: tracks.get(id)?.title || 'Untitled' }));
        };
        const runIndex = async (index) => {
            const result = await playIndex(index);
            syncTerminalView(queue);
            return result;
        };
        window.EveAudioflixAudio?.setQueueBridge?.({
            list: entries,
            index: () => queue().currentIndex,
            step: (delta) => runIndex(queue().currentIndex + (Number(delta) || 0)),
            jump: (index) => runIndex(Number(index) || 0)
        });
        return { trackAt, entries, runIndex };
    }

    function createRuntime({ state, queue, playIndex, getRun, setRun, snapshot }) {
        const bridge = createBridge({ state, queue, playIndex });
        const invalidateRun = () => {
            const next = Number(getRun() || 0) + 1;
            setRun(next);
            return next;
        };
        const restart = async () => {
            const active = queue();
            const track = bridge.trackAt(active.currentIndex) || window.EveAudioflixAudio?.getPlaybackState?.()?.item;
            if (!track) return false;
            const run = invalidateRun();
            const owned = await window.EveAudioflixAudio?.restartCurrent?.(track);
            if (owned !== true) {
                await window.EveAudioflixAudio?.seek?.(0);
                if (run !== getRun()) return false;
                if (window.EveAudioflixAudio?.isInternalViewOpen?.()) await window.EveAudioflixAudio?.openInternalView?.(track);
                else await window.EveAudioflixAudio?.playItem?.(track);
            }
            if (run !== getRun()) return false;
            window.EveAudioflixAudio?.syncQueueView?.();
            return true;
        };
        const complete = create({
            snapshot,
            advance: () => playIndex(queue().currentIndex + 1),
            restart
        });
        const finish = () => {
            queue().isPlaying = false;
            syncTerminalView(queue);
        };
        const release = (detail) => {
            const active = queue();
            if (detail?.status !== 'Stopped' || detail.released !== true || !active.isPlaying
                || detail.item?.id == null || String(detail.item.id) !== String(active.items[active.currentIndex])) return false;
            invalidateRun();
            active.isPlaying = false;
            syncTerminalView(queue);
            return true;
        };
        return { ...bridge, invalidateRun, restart, complete, release, finish };
    }

    Object.assign(ns, {
        ready: true, create, createBridge, createRuntime, isStaleDelivery,
        installStableQueueView, queueViewSignature, patchTerminalTransport, syncTerminalView
    });
})();
