window.EveAudioflixQueueMembership = window.EveAudioflixQueueMembership || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixQueueMembership;
    if (ns.ready) return;

    const MAX_START_TRACE = 10;
    const startTrace = [];
    let queueGeneration = 0;
    let lastObservedGroup = '';
    let lastMeta = null;
    let pendingAction = null;
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const text = (value) => String(value ?? '').trim();

    function publish(ctx, message) {
        if (message) ctx.playbackStatus = message;
        window.EveAudioflixAudio?.syncQueueView?.();
        ctx.rerender?.();
        window.dispatchEvent(new CustomEvent('eve:audioflix-queue-changed'));
    }

    function shortStack(skip = 2) {
        return text(new Error().stack).split('\n').slice(skip, skip + 4).map((line) => line.trim()).join(' <- ');
    }

    function currentFocus() {
        const state = window.EveAudioflixState?.ensure?.() || {};
        return {
            activeFrontendMusicGroup: text(state.activeFrontendMusicGroup),
            activeFrontendMusicArtist: text(state.activeFrontendMusicArtist),
            activeFrontendMusicClassifier: text(state.activeFrontendMusicClassifier),
            activeMusicFolderScope: text(state.activeMusicFolderScope)
        };
    }

    function pushTrace(entry) {
        startTrace.push(entry);
        if (startTrace.length > MAX_START_TRACE) startTrace.splice(0, startTrace.length - MAX_START_TRACE);
        lastMeta = entry;
        window.dispatchEvent(new CustomEvent('eve:audioflix-queue-started', { detail: { ...entry } }));
        return entry;
    }

    function traceFromSnapshot(snapshot, reason, extra = {}) {
        queueGeneration += 1;
        return pushTrace({
            generation: queueGeneration,
            reason: text(reason) || 'unattributed-queue-replace',
            groupName: text(snapshot?.groupName),
            sourceGroup: text(extra.sourceGroup),
            sourceArtist: text(extra.sourceArtist),
            sourceClassifier: text(extra.sourceClassifier),
            itemCount: snapshot?.entries?.length || 0,
            playbackRunId: Number(snapshot?.playbackRunId || 0),
            startedAt: Date.now(),
            renderedGroup: text(extra.renderedGroup),
            focus: extra.focus || currentFocus(),
            stack: text(extra.stack) || shortStack(3)
        });
    }

    function snapshotMeta(queue = {}) {
        const queueGroup = text(queue.groupName);
        const meta = queueGroup && lastMeta?.groupName === queueGroup ? lastMeta : null;
        return {
            queueGeneration: Number(queue.queueGeneration || meta?.generation || 0),
            startReason: text(queue.startReason || meta?.reason),
            sourceGroup: text(queue.sourceGroup || meta?.sourceGroup),
            sourceArtist: text(queue.sourceArtist || meta?.sourceArtist),
            sourceClassifier: text(queue.sourceClassifier || meta?.sourceClassifier),
            startedAt: Number(queue.startedAt || meta?.startedAt || 0),
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
        lastObservedGroup = next.groupName;
        pushTrace({
            generation: queueGeneration,
            reason: next.startReason,
            groupName: next.groupName,
            sourceGroup: next.sourceGroup,
            sourceArtist: next.sourceArtist,
            sourceClassifier: next.sourceClassifier,
            itemCount: next.items.length,
            playbackRunId: 0,
            startedAt: next.startedAt,
            renderedGroup: next.groupName,
            focus: currentFocus(),
            stack: shortStack(3)
        });
        return next;
    }

    function selectionForAction(ctx, actionTarget) {
        const selection = ctx.frontendActiveGroup?.('music');
        if (!selection) return null;
        const data = actionTarget?.dataset || {};
        const renderedName = text(data.afQueueName)
            || text(actionTarget?.closest?.('.audioflix-frontend-subhead')?.nextElementSibling?.dataset?.afActiveGroup);
        if (!renderedName) return selection;
        const currentName = text(selection.name);
        if (renderedName === currentName) return selection;
        ctx.playbackStatus = `Music selection changed before the action ran (${renderedName} → ${currentName || 'current group'}). Refreshed without replacing the queue.`;
        ctx.rerender?.();
        window.dispatchEvent(new CustomEvent('eve:audioflix-queue-stale-action', {
            detail: { renderedName, currentName, action: text(data.afAction), at: Date.now() }
        }));
        return null;
    }

    // Write-time trace: the ctx setter calls this, so the stack names the real writer.
    function noteWrite(prev, next) {
        const group = text(next?.groupName);
        if (!group || group === lastObservedGroup) { lastObservedGroup = group; return; }
        if (next?.startReason && Number(next.queueGeneration || 0) === queueGeneration) { lastObservedGroup = group; return; }
        const action = pendingAction && Date.now() - pendingAction.at < 10000 ? pendingAction : null;
        traceFromSnapshot({ groupName: group, entries: next.items || [], playbackRunId: 0 }, action?.reason || 'unattributed-queue-replace', {
            sourceGroup: next.sourceGroup, renderedGroup: action?.renderedGroup, focus: currentFocus(),
            stack: shortStack(3)
        });
        if (lastMeta) lastMeta.previousGroup = text(prev?.groupName);
        pendingAction = null;
        lastObservedGroup = group;
    }

    function patchQueueSnapshot() {
        const bridge = window.EveAudioflix?.queueConnection;
        if (!bridge?.snapshot || bridge.snapshot.__eveQueueAuthorityTrace) return false;
        const original = bridge.snapshot.bind(bridge);
        const wrapped = () => {
            const snapshot = original();
            const group = text(snapshot?.groupName);
            if (group && group !== lastObservedGroup) {
                const action = pendingAction && Date.now() - pendingAction.at < 10000 ? pendingAction : null;
                traceFromSnapshot(snapshot, action?.reason || 'unattributed-queue-replace', {
                    renderedGroup: action?.renderedGroup,
                    focus: action?.focus,
                    stack: action?.stack
                });
                pendingAction = null;
            }
            lastObservedGroup = group;
            return { ...snapshot, ...snapshotMeta(snapshot) };
        };
        wrapped.__eveQueueAuthorityTrace = true;
        bridge.snapshot = wrapped;
        return true;
    }

    document.addEventListener?.('click', (event) => {
        const target = event.target?.closest?.('[data-af-action]');
        const reason = text(target?.dataset?.afAction);
        if (!['play-music-group', 'open-queue-view'].includes(reason)) return;
        patchQueueSnapshot();
        const renderedGroup = text(target?.dataset?.afQueueName)
            || text(target?.closest?.('.audioflix-frontend-subhead')?.nextElementSibling?.dataset?.afActiveGroup);
        pendingAction = { reason, renderedGroup, focus: currentFocus(), at: Date.now(), stack: shortStack(3) };
        const token = pendingAction;
        setTimeout(() => { if (pendingAction === token) pendingAction = null; }, 10000);
    }, true);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(patchQueueSnapshot, 0), { once: true });
    } else setTimeout(patchQueueSnapshot, 0);

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
                if (at < 0 && q.groupName === q.sourceGroup && trackId) items.push(trackId);
            } else if (at >= 0) items.splice(at, 1);
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
        if (removedCurrent && q.isPlaying) void Promise.resolve(ctx.playQueueIndex?.(nextIndex)).catch(() => false);
        publish(ctx, `${group} queue updated — ${items.length} track${items.length === 1 ? '' : 's'}.`);
        return true;
    }

    Object.assign(ns, { ready: true, start, snapshotMeta, selectionForAction, sync, patchQueueSnapshot, noteWrite });
})();