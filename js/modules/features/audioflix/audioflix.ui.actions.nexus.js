// Nexus Audio Link selection and bulk-edit actions. Kept outside the main dispatcher so scaled
// library management does not make Audioflix's general click router harder to maintain.
window.EveAudioflixUiActionsNexus = window.EveAudioflixUiActionsNexus || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixUiActionsNexus;
    if (ns.ready) return;

    ns.create = function create(ctx) {
        function matchedMusic() {
            const view = ctx.nexusState || {};
            return window.EveAudioflixNexus?.filter?.({
                type: 'music',
                query: view.query,
                facet: view.facet
            }) || [];
        }

        return async function handleNexusAction(actionTarget, action) {
            if (action === 'toggle-sync-playlist-form') {
                const group = actionTarget.dataset.afGroup || '';
                const curr = ctx.syncPlaylistFormOpen || {};
                if (curr.open && curr.group === group) {
                    ctx.syncPlaylistFormOpen = { open: false, group: '' };
                } else {
                    ctx.syncPlaylistFormOpen = { open: true, group };
                }
                ctx.rerender();
                return true;
            }
            if (action === 'toggle-playlist-link-form') {
                const group = actionTarget.dataset.afGroup || '';
                const curr = ctx.playlistLinkFormOpen || {};
                ctx.playlistLinkFormOpen = (curr.open && curr.group === group) ? { open: false, group: '' } : { open: true, group };
                ctx.rerender();
                return true;
            }
            if (action === 'cancel-sync-form') {
                ctx.syncPlaylistFormOpen = { open: false, group: '' };
                ctx.rerender();
                return true;
            }
            const view = ctx.nexusState || {};
            if (action === 'nexus-jump-card') {
                const id = actionTarget.dataset.afId || '';
                const type = actionTarget.dataset.afType === 'sound' ? 'sound' : 'music';
                requestAnimationFrame(() => requestAnimationFrame(() =>
                    window.EveAudioflixNexusQuick?.jumpToCard?.(id, { type, fallbackBackend: true })
                ));
                return true;
            }
            if (action === 'nexus-select-all') {
                ctx.nexusState = Object.assign({}, view, {
                    selectedIds: matchedMusic().map((track) => track.id)
                });
                ctx.rerender();
                return true;
            }
            if (action === 'nexus-clear-selection') {
                ctx.nexusState = Object.assign({}, view, { selectedIds: [] });
                ctx.rerender();
                return true;
            }
            if (action === 'nexus-link-scope' || action === 'nexus-unlink-scope') {
                const selectedIds = view.selectedIds || [];
                if (!selectedIds.length) {
                    const warnMsg = 'Select at least one track to link.';
                    ctx.playbackStatus = warnMsg;
                    if (typeof window.showToast === 'function') window.showToast(warnMsg, 'warning');
                    ctx.rerender();
                    return true;
                }
                const scope = window.EveAudioflixLinks?.inferCurrentScope?.();
                const result = action === 'nexus-link-scope'
                    ? window.EveAudioflixLinks?.add?.(selectedIds, scope, 'music')
                    : window.EveAudioflixLinks?.remove?.(selectedIds, scope, 'music');
                const changed = action === 'nexus-link-scope' ? result?.added : result?.removed;
                let message = '';
                let toastType = 'info';
                if (result?.ok && Number(changed) > 0) {
                    message = `${Number(changed)} track reference(s) ${action === 'nexus-link-scope' ? 'attached to' : 'detached from'} ${result.label || 'the current surface'}.`;
                    toastType = 'success';
                } else if (result?.reason) {
                    message = result.reason;
                    toastType = result?.ok ? 'info' : 'warning';
                } else {
                    message = `${Number(changed) || 0} track reference(s) updated.`;
                }
                ctx.playbackStatus = message;
                if (typeof window.showToast === 'function') {
                    window.showToast(message, toastType);
                }
                if (result?.ok) {
                    ctx.nexusState = Object.assign({}, view, { selectedIds: [] });
                }
                ctx.rerender();
                return true;
            }
            if (action !== 'nexus-apply-bulk') return false;

            const selectedIds = view.selectedIds || [];
            if (!selectedIds.length) {
                const warnMsg = 'Select at least one track to organize.';
                ctx.playbackStatus = warnMsg;
                if (typeof window.showToast === 'function') window.showToast(warnMsg, 'warning');
                ctx.rerender();
                return true;
            }

            const manager = actionTarget?.closest?.('.audioflix-bulk-manager');
            const groupActionInput = manager?.querySelector?.('[data-af-bulk-field="groupAction"]')?.value;
            const groupInput = manager?.querySelector?.('[data-af-bulk-field="group"]')?.value;
            const classifierActionInput = manager?.querySelector?.('[data-af-bulk-field="classifierAction"]')?.value;
            const classifierInput = manager?.querySelector?.('[data-af-bulk-field="classifier"]')?.value;
            const folderActionInput = manager?.querySelector?.('[data-af-bulk-field="folderAction"]')?.value;
            const folderInput = manager?.querySelector?.('[data-af-bulk-field="folder"]')?.value;

            const bulk = Object.assign({
                groupAction: groupActionInput || 'add',
                group: groupInput !== undefined ? groupInput : '',
                classifierAction: classifierActionInput || 'add',
                classifier: classifierInput !== undefined ? classifierInput : '',
                folderAction: folderActionInput !== undefined ? folderActionInput : '',
                folder: folderInput !== undefined ? folderInput : ''
            }, view.bulk || {});

            const changes = {
                addGroups: (bulk.groupAction === 'add' && bulk.group) ? [bulk.group] : [],
                removeGroups: (bulk.groupAction === 'remove' && bulk.group) ? [bulk.group] : [],
                addClassifiers: (bulk.classifierAction === 'add' && bulk.classifier) ? [bulk.classifier] : [],
                removeClassifiers: (bulk.classifierAction === 'remove' && bulk.classifier) ? [bulk.classifier] : [],
                folderAction: bulk.folderAction || '',
                folder: bulk.folder || ''
            };
            const hasChange = changes.addGroups.length || changes.removeGroups.length
                || changes.addClassifiers.length || changes.removeClassifiers.length
                || changes.folderAction;
            if (!hasChange) {
                const warnMsg = 'Choose at least one group, classifier, or folder operation.';
                ctx.playbackStatus = warnMsg;
                if (typeof window.showToast === 'function') window.showToast(warnMsg, 'warning');
                ctx.rerender();
                return true;
            }

            const result = window.EveAudioflixBulk?.applyMusicChanges?.(selectedIds, changes);
            if (result?.ok && Number(result.changed) > 0) {
                changes.addGroups.forEach((group) => selectedIds.forEach((id) => window.EveAudioflix?.queueConnection?.syncGroupMembership?.(id, group, true)));
                changes.removeGroups.forEach((group) => selectedIds.forEach((id) => window.EveAudioflix?.queueConnection?.syncGroupMembership?.(id, group, false)));
            }
            let message = '';
            let toastType = 'info';
            if (result?.ok) {
                if (Number(result.changed) > 0) {
                    message = `${result.changed} of ${result.selected} selected track(s) updated in one transaction.`;
                    toastType = 'success';
                } else {
                    message = result.reason || 'Those tracks already match the requested organization.';
                    toastType = 'info';
                }
                ctx.nexusState = Object.assign({}, view, { selectedIds: [], bulk: {} });
            } else {
                message = result?.reason || 'Bulk organization failed.';
                toastType = 'warning';
            }
            ctx.playbackStatus = message;
            if (typeof window.showToast === 'function') {
                window.showToast(message, toastType);
            }
            ctx.rerender();
            return true;
        };
    };

    ns.ready = true;
})();
