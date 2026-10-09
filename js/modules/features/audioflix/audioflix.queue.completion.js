window.EveAudioflixQueueCompletion = window.EveAudioflixQueueCompletion || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixQueueCompletion;
    if (ns.ready) return;
    function create({ snapshot, advance, restart }) {
        let consumed = '';
        return function complete(detail = {}) {
            const queue = snapshot();
            const entry = queue?.entries?.[queue.currentIndex];
            if (detail.status !== 'Ended' || !queue?.isPlaying || !entry) return false;
            const id = String(entry.id ?? '');
            if (detail.item?.id != null && String(detail.item.id) !== id) return false;
            const run = queue.playbackRunId;
            const key = `${id}:${run}`;
            if (consumed === key) return false;
            consumed = key;
            Promise.resolve(detail.settle).catch(() => false).then(async () => {
                const latest = snapshot();
                if (!latest?.isPlaying || latest.playbackRunId !== run
                    || String(latest.entries?.[latest.currentIndex]?.id ?? '') !== id) return;
                // The live repeat toggle and current ordering have one owner, independent of view.
                await (latest.repeatOne ? restart() : advance());
            }).catch(error => {
                window.EveAudioflixDiagnostics?.record?.('queue:completion-error', 0, { error: true });
                console.warn('[Audioflix] Queue completion failed:', error?.message || error);
            });
            return true;
        };
    }
    Object.assign(ns, { ready: true, create });
})();
