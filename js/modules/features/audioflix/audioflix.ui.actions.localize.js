// Localization + Nexus-panel click handlers for the Audioflix panel. Split out of
// audioflix.ui.actions.js to keep that dispatcher under the project line cap. Each handler shares the
// same `ctx` accessor bag as the main dispatcher and returns TRUE once it has handled an action, so
// the caller can fall through to its own handlers when this module does not recognise the action.
window.EveAudioflixUiActionsLocalize = window.EveAudioflixUiActionsLocalize || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixUiActionsLocalize;
    if (ns.ready) return;

    ns.create = function create(ctx) {
        const tieMusicFolderGrant = (folderName, granted) => {
            const S = window.EveAudioflixState;
            const snapshot = S?.ensure?.() || {};
            const wanted = String(folderName || '').trim().toLowerCase();
            if (!wanted || !granted?.id) return;
            const connections = (snapshot.musicPortConnections || []).map((entry) => (
                String(entry.folder || '').trim().toLowerCase() === wanted
                    ? { ...entry, browserFolderId: granted.id, browserRootName: granted.nickname || entry.browserRootName || entry.folder }
                    : entry
            ));
            if (connections.some((entry) => entry.browserFolderId === granted.id)) {
                S?.update?.({ musicPortConnections: connections }, 'audioflix-music-port-browser-link');
            }
        };
        return async function handleLocalizeAction(actionTarget, action) {
        // Grant the music folder right here, while the user is already choosing it. A browser can
        // only read a directory it has been handed a handle for, so without this the tracks import
        // fine but will not play unless the SAME folder is granted again over in Ports. One picker,
        // at the moment it makes sense, and the grant persists in IndexedDB.
        if (action === 'grant-music-folder') {
            const FS = window.EveAudioflixFsPorts;
            if (!FS?.supported?.()) {
                ctx.playbackStatus = 'This browser cannot grant folder access (needs Edge/Chrome).';
                ctx.rerender();
                return true;
            }
            try {
                const granted = await FS.addFolder({
                    nickname: actionTarget.dataset.afNickname || '',
                    purpose: 'music'
                });
                tieMusicFolderGrant(actionTarget.dataset.afFolder || actionTarget.dataset.afKey || '', granted);
                await FS.reconcile?.();
                FS.clearPathCache?.();
                await window.EveAudioflixLocalize?.auditScopeDiskStatus?.('library', '');
                ctx.playbackStatus = `Granted "${granted.nickname}" — its tracks now play without the EveOS server.`;
            } catch (err) {
                ctx.playbackStatus = err?.name === 'AbortError' ? 'Folder access cancelled.' : (err?.message || 'Could not grant that folder.');
            }
            await ctx.loadPortedSounds();
            return true;
        }
        if (action === 'regrant-music-folder') {
            const FS = window.EveAudioflixFsPorts;
            const recId = actionTarget.dataset.afId || '';
            const nickname = actionTarget.dataset.afNickname || actionTarget.dataset.afKey || 'Audioflix Music';
            if (!FS?.supported?.()) {
                ctx.playbackStatus = 'Folder access needs Edge or Chrome with File System Access support.';
                ctx.rerender();
                return true;
            }
            try {
                const granted = await FS.addFolder({
                    id: recId,
                    nickname,
                    purpose: 'music'
                });
                await FS.reconcile?.();
                FS.clearPathCache?.();
                await window.EveAudioflixLocalize?.auditScopeDiskStatus?.('library', '');
                ctx.playbackStatus = `Re-granted music folder "${granted.nickname}".`;
            } catch (err) {
                if (err?.name !== 'AbortError') ctx.playbackStatus = err?.message || 'Folder re-grant failed';
            }
            await ctx.loadPortedSounds();
            return true;
        }
        if (action === 'remove-music-fsport') {
            const FS = window.EveAudioflixFsPorts;
            const recId = actionTarget.dataset.afId || '';
            if (recId) {
                try {
                    await FS.removeFolder(recId);
                    await FS.reconcile?.();
                    FS.clearPathCache?.();
                    ctx.playbackStatus = 'Music folder port disconnected.';
                } catch (err) {
                    ctx.playbackStatus = err?.message || 'Failed to disconnect music folder.';
                }
            }
            await ctx.loadPortedSounds();
            return true;
        }
        if (action === 'grant-localize-folder') {
            const FS = window.EveAudioflixFsPorts;
            const scope = actionTarget.dataset.afScope || 'library';
            const key = actionTarget.dataset.afKey || '';
            if (!FS?.supported?.()) {
                ctx.playbackStatus = 'Folder access needs Edge or Chrome with File System Access support.';
                ctx.rerender();
                return true;
            }
            try {
                const granted = await FS.addFolder({
                    nickname: actionTarget.dataset.afNickname || key || 'Audioflix Music',
                    purpose: 'music'
                });
                if (scope === 'folder') tieMusicFolderGrant(key, granted);
                await FS.reconcile?.();
                FS.clearPathCache?.();
                const audit = await window.EveAudioflixLocalize?.auditScopeDiskStatus?.(scope, key);
                ctx.playbackStatus = audit?.unverified
                    ? `Granted "${granted.nickname}", but ${audit.unverified} track(s) remain outside that folder.`
                    : `Granted "${granted.nickname}" and verified ${audit?.verified || 0} local track(s).`;
            } catch (err) {
                ctx.playbackStatus = err?.name === 'AbortError'
                    ? 'Folder access cancelled.'
                    : (err?.message || 'Could not grant that folder.');
            }
            await ctx.loadPortedSounds();
            return true;
        }
        if (action === 'toggle-localize-form') {
            const scope = actionTarget.dataset.afScope || 'library';
            const key = actionTarget.dataset.afKey || '';
            const curr = ctx.localizeFormOpen || {};
            if (curr.open && curr.scope === scope && curr.key === key) {
                ctx.localizeFormOpen = { open: false, scope: 'library', key: '' };
            } else {
                ctx.localizeFormOpen = { open: true, scope, key };
                ctx.musicPortFormOpen = false;
                ctx.importFormOpen = false;
                window.EveAudioflixLocalize?.auditScopeDiskStatus?.(scope, key).then(() => ctx.rerender());
            }
            ctx.rerender();
            return true;
        }
        if (action === 'retry-spotify-fallback') {
            const L = window.EveAudioflixLocalize;
            const pending = L?.getSpotifyRecovery?.();
            if (!pending?.failures?.length) {
                ctx.playbackStatus = 'No Spotify fallback recovery is pending.';
                ctx.rerender();
                return true;
            }
            ctx.playbackStatus = `Trying Spotify Fallback for ${pending.failures.length} failed track${pending.failures.length === 1 ? '' : 's'}...`;
            ctx.rerender();
            const res = await L.retrySpotifyRecovery((p) => {
                ctx.playbackStatus = `Spotify Fallback ${p.index}/${p.total}: ${p.title}`;
                ctx.rerender();
            });
            ctx.playbackStatus = res.ok
                ? `Spotify Fallback localized ${res.done}/${res.total}${res.failed ? `; ${res.failed} still failed — ${res.lastError}` : '.'}`
                : (res.reason || `Spotify Fallback failed${res.lastError ? ` — ${res.lastError}` : '.'}`);
            const stillPending = L.getSpotifyRecovery?.();
            if (!stillPending?.failures?.length) ctx.localizeFormOpen = { open: false, scope: 'library', key: '' };
            window.EveAudioflixState?.flush?.('audioflix-spotify-fallback-complete');
            ctx.rerender();
            return true;
        }
        if (action === 'dismiss-spotify-recovery') {
            window.EveAudioflixLocalize?.clearSpotifyRecovery?.();
            ctx.playbackStatus = 'Spotify fallback recovery dismissed; no fallback retry was run.';
            ctx.rerender();
            return true;
        }
        if (action === 'localize-spotify-fallback-scope') {
            const L = window.EveAudioflixLocalize;
            const form = actionTarget.closest('form');
            if (!L || !form) return true;
            const data = new FormData(form);
            const scope = form.dataset.afScope || 'library';
            const key = form.dataset.afKey || '';
            const targetDir = String(data.get('targetDir') || '').trim();
            const force = data.get('force') === '1' || data.get('force') === 'on';
            const mode = ['dup', 'smart', 'link'].includes(String(data.get('mode') || '')) ? String(data.get('mode')) : 'link';
            const mediaFormat = data.get('mediaFormat') === 'video' ? 'video' : 'audio';
            const spotifyCount = (L.collectScope?.(scope, key) || []).filter((item) => L.isSpotifyTrack?.(item)).length;
            if (!targetDir) {
                ctx.playbackStatus = 'Choose a target folder before using Spotify Fallback.';
                ctx.rerender();
                return true;
            }
            if (!spotifyCount) {
                ctx.playbackStatus = 'This scope has no Spotify-linked tracks for the fallback resolver.';
                ctx.rerender();
                return true;
            }
            ctx.playbackStatus = `Using Spotify Fallback for Spotify-linked tracks in this scope (${spotifyCount} available)...`;
            ctx.rerender();
            const res = await L.localizeScope(scope, key, targetDir, (p) => {
                ctx.playbackStatus = `${p.resolverMode === 'spotify-fallback' ? 'Spotify Fallback' : 'Localizing'} ${p.index}/${p.total}: ${p.title}`;
                ctx.rerender();
            }, force, mode, mediaFormat, 'spotify-fallback');
            ctx.playbackStatus = res.ok
                ? (scope === 'group'
                    ? `Fallback run complete — ${res.done} downloaded, ${res.shortcut || 0} shortcut${res.shortcut === 1 ? '' : 's'}, ${res.skipped || 0} kept${res.failed ? `, ${res.failed} failed — ${res.lastError}` : ''}.`
                    : `Fallback run localized ${res.done}/${res.total} to ${res.targetDir}${res.failed ? ` (${res.failed} failed — ${res.lastError})` : ''}.`)
                : (res.reason || 'Spotify fallback localization failed.');
            if (!res.failed) ctx.localizeFormOpen = { open: false, scope: 'library', key: '' };
            window.EveAudioflixState?.flush?.('audioflix-spotify-fallback-scope-complete');
            ctx.rerender();
            return true;
        }
        if (action === 'toggle-missing-list') {
            const scope = actionTarget.dataset.afScope || 'library';
            const key = actionTarget.dataset.afKey || '';
            const curr = ctx.missingListOpen || {};
            if (curr.open && curr.scope === scope && curr.key === key) {
                ctx.missingListOpen = { open: false, scope: '', key: '' };
            } else {
                ctx.missingListOpen = { open: true, scope, key };
            }
            ctx.rerender();
            return true;
        }
        if (action === 'open-nexus-search') {
            if (typeof ctx.close === 'function') ctx.close();
            if (typeof window.openExpandedSearchModal === 'function') {
                window.openExpandedSearchModal();
            } else if (window.EveOS?.SearchAdvanced?.UI?.openExpandedSearchModal) {
                window.EveOS.SearchAdvanced.UI.openExpandedSearchModal();
            } else if (typeof window.openSearchModal === 'function') {
                window.openSearchModal();
            }
            return true;
        }
        if (action === 'toggle-group-paths') {
            const key = actionTarget.dataset.afGroup || '', cur = ctx.groupPathsOpen || {};
            ctx.groupPathsOpen = (cur.open && cur.key === key) ? { open: false, key: '' } : { open: true, key };
            ctx.rerender(); return true;
        }
        if (action === 'toggle-group-paths-scope') {
            const key = actionTarget.dataset.afGroup || '';
            const scope = actionTarget.dataset.afScope || 'first';
            const curAll = ctx.groupPathsScopesOpen || {};
            const curGroup = curAll[key] || { first: false, group: false };
            ctx.groupPathsScopesOpen = {
                ...curAll,
                [key]: { ...curGroup, [scope]: !curGroup[scope] }
            };
            ctx.rerender();
            return true;
        }
        if (action === 'toggle-nexus') {
            const nType = actionTarget.dataset.afType || 'music', st = ctx.nexusState || {};
            ctx.nexusState = (st.open && st.type === nType) ? { open: false, type: nType, query: '', facet: '' } : { open: true, type: nType, query: st.query || '', facet: '' };
            ctx.rerender(); return true;
        }
        if (action === 'nexus-facet') {
            const targetFacet = actionTarget.dataset.afFacet || '';
            const st = ctx.nexusState || {};
            const nextFacet = st.facet === targetFacet ? '' : targetFacet;
            ctx.nexusState = { ...st, facet: nextFacet };
            ctx.rerender();
            return true;
        }
        if (action === 'toggle-nexus-section') {
            const sec = actionTarget.dataset.afSection;
            if (sec && window.EveAudioflixNexusUi?.toggleSection) window.EveAudioflixNexusUi.toggleSection(sec);
            ctx.rerender();
            return true;
        }
        if (action === 'audit-scope-disk') {
            const scope = actionTarget.dataset.afScope || 'library';
            const key = actionTarget.dataset.afKey || '';
            const L = window.EveAudioflixLocalize;
            if (L) {
                ctx.playbackStatus = 'Auditing local disk files...'; ctx.rerender();
                L.auditScopeDiskStatus(scope, key).then(res => {
                    ctx.playbackStatus = res.unverified
                        ? `Could not verify ${res.unverified} local track(s). Start localhost or use Grant File Access; none were marked deleted.`
                        : `Disk Audit Complete: ${res.missing} file(s) missing on disk out of ${res.checked} local track(s).`;
                    ctx.rerender();
                });
            }
            return true;
        }
        if (action === 'recalibrate-scope-path') {
            const scope = actionTarget.dataset.afScope || 'library';
            const key = actionTarget.dataset.afKey || '';
            const form = actionTarget.closest('form');
            const input = form ? form.querySelector('input[name="targetDir"]') : null;
            const targetDir = input ? input.value : window.EveAudioflixLocalize?.getScopeDir?.(scope, key);
            const L = window.EveAudioflixLocalize;
            if (L && targetDir) {
                ctx.playbackStatus = 'Recalibrating local track paths...'; ctx.rerender();
                L.recalibrateScopePath(scope, key, targetDir).then(res => {
                    ctx.playbackStatus = res.ok
                        ? `Recalibrated ${res.recalibrated}/${res.total} track path(s) to ${res.targetDir} (0 web downloads).`
                        : (res.reason || 'Recalibration failed.');
                    ctx.localizeFormOpen = { open: false, scope: 'library', key: '' };
                    ctx.rerender();
                });
            }
            return true;
        }
        if (action === 'toggle-music-port-form') {
            ctx.musicPortFormOpen = !ctx.musicPortFormOpen;
            if (ctx.musicPortFormOpen) {
                ctx.localizeFormOpen = { open: false, scope: 'library', key: '' };
                ctx.importFormOpen = false;
            }
            ctx.rerender();
            return true;
        }
            // ---- classifiers ----------------------------------------------------------------
            if (action === 'toggle-classifier-manager') {
                ctx.classifierManagerOpen = !ctx.classifierManagerOpen;
                if (ctx.classifierManagerOpen) { ctx.musicPortFormOpen = false; ctx.importFormOpen = false; }
                ctx.rerender();
                return true;
            }
            if (action === 'open-classifier-detail') {
                const id = actionTarget.dataset.afClassifierId || '';
                ctx.classifierDetailId = ctx.classifierDetailId === id ? '' : id;   // click again closes
                ctx.rerender();
                return true;
            }
            if (action === 'toggle-classifier-row') {
                ctx.classifierRowOpen = !ctx.classifierRowOpen;
                ctx.rerender();
                return true;
            }
            if (action === 'remove-classifier') {
                const name = actionTarget.dataset.afClassifier || '';
                const res = window.EveAudioflixClassifiers?.removeManual?.(name);
                ctx.playbackStatus = res?.ok ? `Removed classifier "${name}" and detached it everywhere.` : 'Could not remove that classifier.';
                ctx.rerender();
                return true;
            }
            if (action === 'rename-classifier') {
                const name = actionTarget.dataset.afClassifier || '';
                let next = '';
                try { next = String((await window.showPrompt?.(`Rename classifier "${name}":`, name)) || '').trim(); } catch { }
                if (next && next !== name) {
                    const res = window.EveAudioflixClassifiers?.renameManual?.(name, next);
                    ctx.playbackStatus = res?.ok ? `Renamed classifier to "${next}".` : (res?.reason || 'Rename failed.');
                    ctx.rerender();
                }
                return true;
            }
            return false;
        };
    };

    ns.ready = true;
})();
