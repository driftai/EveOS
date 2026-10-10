window.EveAudioflixQueueMembership = window.EveAudioflixQueueMembership || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixQueueMembership;
    if (ns.ready) return;

    const MAX_START_TRACE = 10;
    const startTrace = [];
    let queueGeneration = 0;
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const text = (value) => String(value ?? '').trim();

    function publish(ctx, message) {
        if (message) ctx.playbackStatus = message;
        window.EveAudioflixAudio?.syncQueueView?.();
        ctx.rerender?.();
        window.dispatchEvent(new CustomEvent('eve:audioflix-queue-changed'));
    }

    function shortStack() {
        return text(new Error().stack).split('\n').slice(2, 6).map((line) => line.trim()).join(' <- ');
    }

    function traceEntry(queue, reason) {
        return {
            generation: Number(queue.queueGeneration || 0),
            reason: text(reason),
            groupName: text(queue.groupName),
            sourceGroup: text(queue.sourceGroup),
            sourceArtist: text(queue.sourceArtist),
            sourceClassifier: text(queue.sourceClassifier),
            itemCount: queue.items?.length || 0,
            startedAt: Number(queue.startedAt || 0),
            stack: shortStack()
        };
    }

    function snapshotMeta(queue = {}) {
        return {
            queueGeneration: Number(queue.queueGeneration || 0),
            startReason: text(queue.startReason),
            sourceGroup: text(queue.sourceGroup),
            sourceArtist: text(queue.sourceArtist),
            sourceClassifier: text(queue.sourceClassifier),
            startedAt: Number(queue.startedAt || 0),
            queueStartTrace: startTrace.map((entry) => ({ ...entry }))
        };
    }

    function start(ctx, selection, reason = 'queue-start') {
        const items = Array.isArray(selection?.items) ? selection.items : [];
        if (!items.length) return null;
        const prev = ctx.activeMusicQueue || {};
        let ids = items.map((item) => item?.id).filter(Boolean);
        if (!ids.length) return null;
        if (prev.shuffle === true) ids = ctx.shuffleQueue?.(ids) || ids;
        ctx.invalidateQueueRun?.();
        queueGeneration = Math.max(queueGeneration + 1, Number(prev.queueGeneration || 0) + 1);
        const next = {
            groupName: text(selection.name),
            sourceGroup: text(selection.activeGroup),
            sourceArtist: text(selection.activeArtist),
            sourceClassifier: text(selection.activeClassifier),
            items: ids,
            currentIndex: 0,
            isPlaying: true,
            shuffle: prev.shuffle === true,
            loop: prev.loop === true,
            queueGeneration,
            startReason: text(reason) || 'queue-start',
            startedAt: Date.now()
        };
        ctx.activeMusicQueue = next;
        const entry = traceEntry(next, next.startReason);
        startTrace.push(entry);
        if (startTrace.length > MAX_START_TRACE) startTrace.splice(0, startTrace.length - MAX_START_TRACE);
        window.dispatchEvent(new CustomEvent('eve:audioflix-queue-started', { detail: { ...entry } }));
        return next;
    }

    function selectionForAction(ctx, actionTarget) {
        const selection = ctx.frontendActiveGroup?.('music');
        if (!selection) return null;
        const data = actionTarget?.dataset || {};
        if (!Object.prototype.hasOwnProperty.call(data, 'afQueueName')) return selection;
        const rendered = {
            name: text(data.afQueueName),
            activeGroup: text(data.afQueueGroup),
            activeArtist: text(data.afQueueArtist),
            activeClassifier: text(data.afQueueClassifier)
        };
        const current = {
            name: text(selection.name),
            activeGroup: text(selection.activeGroup),
            activeArtist: text(selection.activeArtist),
            activeClassifier: text(selection.activeClassifier)
        };
        if (Object.keys(rendered).every((key) => rendered[key] === current[key])) return selection;
        ctx.playbackStatus = `Music selection changed before the action ran (${rendered.name || 'rendered group'} → ${current.name || 'current group'}). Refreshed without replacing the queue.`;
        ctx.rerender?.();
        window.dispatchEvent(new CustomEvent('eve:audioflix-queue-stale-action', {
            detail: { rendered, current, action: text(data.afAction), at: Date.now() }
        }));
        return null;
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

    Object.assign(ns, { ready: true, start, snapshotMeta, selectionForAction, sync });
})();