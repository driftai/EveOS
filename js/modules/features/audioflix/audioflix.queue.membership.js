window.EveAudioflixQueueMembership = window.EveAudioflixQueueMembership || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixQueueMembership;
    if (ns.ready) return;

    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

    function publish(ctx, message) {
        if (message) ctx.playbackStatus = message;
        window.EveAudioflixAudio?.syncQueueView?.();
        ctx.rerender?.();
        window.dispatchEvent(new CustomEvent('eve:audioflix-queue-changed'));
    }

    function scopedIds(ctx, queue) {
        const current = ctx.frontendActiveGroup?.('music');
        if (!current || !same(current.activeGroup, queue.sourceGroup) || current.name !== queue.groupName) return null;
        return (current.items || []).map((item) => item.id);
    }

    function sync(ctx, trackId, group, on) {
        const q = ctx.activeMusicQueue || {};
        if (!q.items?.length || !q.sourceGroup || !same(q.sourceGroup, group)) return false;

        const currentId = q.items[q.currentIndex] || '';
        const wanted = scopedIds(ctx, q);
        let items;

        if (wanted) {
            const desired = new Set(wanted);
            items = q.items.filter((id) => desired.has(id));
            wanted.forEach((id) => { if (!items.includes(id)) items.push(id); });
        } else {
            items = [...q.items];
            const at = items.indexOf(trackId);
            if (on === true) {
                // If the original queue had extra artist/classifier scope and that scope is no
                // longer selected, do not guess whether a newly-added group member belongs there.
                if (at < 0 && q.groupName === q.sourceGroup && trackId) items.push(trackId);
            } else if (at >= 0) {
                // Removal is always safe: a track outside the source group cannot remain in its queue.
                items.splice(at, 1);
            }
        }

        if (items.length === q.items.length && items.every((id, index) => id === q.items[index])) return false;
        const removedCurrent = !!currentId && !items.includes(currentId);
        if (!items.length) {
            ctx.invalidateQueueRun?.();
            ctx.activeMusicQueue = { ...q, items: [], currentIndex: -1, isPlaying: false };
            if (removedCurrent) void window.EveAudioflixAudio?.stopAll?.();
            publish(ctx, `${group} queue is now empty.`);
            return true;
        }

        const nextIndex = removedCurrent ? Math.min(Math.max(q.currentIndex, 0), items.length - 1)
            : Math.max(0, items.indexOf(currentId));
        ctx.activeMusicQueue = { ...q, items, currentIndex: nextIndex };
        if (removedCurrent && q.isPlaying) {
            void Promise.resolve(ctx.playQueueIndex?.(nextIndex)).catch(() => false);
        }
        publish(ctx, `${group} queue updated — ${items.length} track${items.length === 1 ? '' : 's'}.`);
        return true;
    }

    Object.assign(ns, { ready: true, sync });
})();