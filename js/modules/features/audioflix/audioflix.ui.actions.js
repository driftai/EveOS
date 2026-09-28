// Click-action + form-submit dispatchers for the Audioflix panel, split out of audioflix.ui.js to
// keep that view under the line cap. The panel's mutable UI state still lives in ui.js as the single
// source of truth; this module reaches it through a `ctx` accessor facade (getters/setters over those
// closure locals), so the renderers there keep reading the same variables unchanged.
window.EveAudioflixUiActions = window.EveAudioflixUiActions || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixUiActions;
    if (ns.ready) return;
    ns.create = function create(ctx) {
        const localizeActions = window.EveAudioflixUiActionsLocalize.create(ctx);
        const nexusActions = window.EveAudioflixUiActionsNexus.create(ctx);
        const providerActions = [
            window.EveAudioflixSpotifyUi?.createActions?.(ctx),
            window.EveAudioflixInstagramUi?.createActions?.(ctx)
        ].filter(Boolean);
        const stopItemPlayback = (id, preserveProvider = false) => Promise.allSettled([window.EveAudioflixAudio?.stopItemLayers?.(id, preserveProvider), window.EveAudioflixNative?.clearVoices?.(id), window.EveAudioflixNative?.clearVoices?.('hk:' + id)]);
        async function handleAction(actionTarget, e) {
            const action = actionTarget.dataset.afAction, id = actionTarget.dataset.afId, type = actionTarget.dataset.afType;
            if (action?.startsWith('piano-')) return window.EveAudioflixPianoUi?.handleAction?.(actionTarget, e);
            if (action?.startsWith('soundlab-')) {
                const result = await window.EveAudioflixSoundLabUi?.handleAction?.(actionTarget, e);
                if (result?.rerender) ctx.rerender();
                return;
            }
            const item = id ? (ctx.findItem(type, id) || ctx.portedSounds.find(s => s.id === id)) : null;
            if (action === 'stop-item') {
                ctx.stopRepeater(id);
                return stopItemPlayback(id).then(() => true);
            }
            if (action === 'toggle-repeater') {
                if (ctx.activeRepeaters[id]) ctx.stopRepeater(id);
                else ctx.startRepeater(item, Math.max(100, parseFloat(document.getElementById('audioflix-rep-interval')?.value || 1.0) * 1000), parseInt(document.getElementById('audioflix-rep-count')?.value || 0, 10));
                return;
            }
            if (action === 'layer-play') return item && window.EveAudioflixAudio?.layerPlay?.({ ...item, type: type || item.type });
            if (action === 'internal-view') { if (item) try { await window.EveAudioflixAudio?.openInternalView?.(item); } catch (err) { ctx.playbackStatus = err.message || 'Internal player failed'; ctx.rerender(); } return; }
            if (action === 'item-info') {
                // Modal-only swap: nothing outside the settings panel changes, so do not rebuild
                // every card (that stall is what made a playing song hitch on open).
                if (!item) return; ctx.activeInfoItem = item; ctx.activeInfoType = type; ctx.rerenderModal();
                if (Number(item.duration || 0) <= 0) {
                    const duration = await window.EveAudioflixTransport?.probeItem?.(item, type || item.type, { resolveProvider: true }).catch?.(() => 0);
                    if (duration > 0 && ctx.activeInfoItem?.id === item.id) ctx.rerenderModal();
                }
                return;
            }
            if (action === 'delete-item') {
                if (!item) return;
                const label = type === 'music' ? 'track' : 'sound';
                if (!window.confirm(`Delete "${item.title || label}" from Audioflix? This removes the library entry, not the source file on disk.`)) return;
                ctx.stopRepeater(id);
                const q = ctx.activeMusicQueue || {};
                const queueIndex = type === 'music' ? (q.items || []).indexOf(id) : -1;
                const wasCurrent = queueIndex >= 0 && q.currentIndex === queueIndex;
                if (wasCurrent || String(window.EveAudioflixAudio?.getPlaybackState?.()?.item?.id || '') === String(id || '')) {
                    await stopItemPlayback(id);
                }
                if (queueIndex >= 0) {
                    ctx.invalidateQueueRun?.();
                    const nextItems = q.items.filter((entryId) => entryId !== id);
                    const nextIndex = nextItems.length ? Math.min(queueIndex, nextItems.length - 1) : -1;
                    ctx.activeMusicQueue = { ...q, items: nextItems, currentIndex: nextIndex, isPlaying: q.isPlaying && nextItems.length > 0 };
                }
                window.EveAudioflixState?.removeItem?.(type, id);
                ctx.activeInfoItem = ctx.activeInfoType = null;
                if (wasCurrent && ctx.activeMusicQueue?.isPlaying) await ctx.playQueueIndex(ctx.activeMusicQueue.currentIndex);
                window.EveAudioflixAudio?.syncQueueView?.();
                ctx.rerender();
                return;
            }
            if (action === 'close-info') { ctx.activeInfoItem = ctx.activeInfoType = null; ctx.rerenderModal(); return; }
            if (action === 'copy-url') {
                try {
                    await navigator.clipboard.writeText(actionTarget.dataset.afUrl || '');
                    const orig = actionTarget.textContent; actionTarget.textContent = 'Copied!'; actionTarget.style.borderColor = actionTarget.style.color = '#00d4ff';
                    setTimeout(() => { actionTarget.textContent = orig; actionTarget.style.borderColor = actionTarget.style.color = ''; }, 1500);
                } catch {}
                return;
            }
            if (action === 'submit-form') { const f = actionTarget.closest('form'); if (f?.reportValidity()) handleForm(f); return; }
            if (action === 'tab') {
                ctx.activeTab = actionTarget.dataset.afTab || 'soundboard';
                window.EveAudioflixSoundLabUi?.setVisible?.(ctx.activeTab === 'soundlab'); window.EveAudioflixPianoUi?.setVisible?.(ctx.activeTab === 'piano');
                ctx.pushHotkeysToBridge();
                ctx.rerender();
                return;
            }
            if (action === 'open-localhost') { window.open('http://localhost:8765/EveOS.html', '_blank', 'noopener'); ctx.playbackStatus = 'Opening Localhost EveOS in a new tab...'; ctx.rerender(); return; }
            if (action === 'toggle-local-badge') { actionTarget.closest('.audioflix-local-badge')?.classList.toggle('is-minimized'); return; }
            if (action === 'toggle-routing-drawer') { ctx.routingOpen = !ctx.routingOpen; ctx.rerender(); return; }
            if (action === 'open-reader-companion') { window.EveWorldBookNarrationBridge?.openCompanion?.(); return; }
            if (action === 'toggle-settings') { ctx.settingsOpen = !ctx.settingsOpen; ctx.rerender(); return; }
            if (action === 'toggle-group') { const gName = actionTarget.dataset.afGroup; if (gName) { ctx.collapsedGroups = { ...ctx.collapsedGroups, [gName]: !ctx.collapsedGroups[gName] }; ctx.rerender(); } return; }
            if (action === 'toggle-fullscreen') { ctx.fullscreenOn = !ctx.fullscreenOn; ctx.overlay?.classList.toggle('is-fullscreen', ctx.fullscreenOn); ctx.rerender(); return; }
            if (action === 'toggle-add') { const key = (type === 'music' || ctx.activeTab === 'music') ? 'music' : 'sound'; ctx.addFormOpen = { ...ctx.addFormOpen, [key]: !ctx.addFormOpen[key] }; ctx.rerender(); return; }
            if (action === 'toggle-ports') { ctx.portsOpen = !ctx.portsOpen; ctx.rerender(); return; }
            if (action === 'toggle-groups') { const key = (type === 'music' || ctx.activeTab === 'music') ? 'music' : 'sound'; ctx.groupsOpen = { ...ctx.groupsOpen, [key]: !ctx.groupsOpen[key] }; ctx.rerender(); return; }
            if (action === 'toggle-folders') { ctx.foldersOpen = { ...ctx.foldersOpen, music: !ctx.foldersOpen.music }; ctx.rerender(); return; }
            if (action === 'select-folder-scope') {
                window.EveAudioflixState?.update?.({
                    activeMusicFolderScope: actionTarget.dataset.afScope || '',
                    activeFrontendMusicGroup: '',
                    activeFrontendMusicArtist: '',
                    activeFrontendMusicClassifier: ''
                }, 'audioflix-folder-scope');
                ctx.rerender();
                return;
            }
            if (action === 'rename-group-prompt') {
                const oldGroup = actionTarget.dataset.afGroup;
                const isM = type === 'music';
                let newGroup = '';
                try { newGroup = String((await window.showPrompt?.(`Rename group "${oldGroup}":`, oldGroup)) || '').trim(); } catch {}
                if (isM) {
                    const currentDir = window.EveAudioflixLocalize?.getScopeDir?.('group', oldGroup) || '';
                    let newDir = '';
                    try { newDir = String((await window.showPrompt?.(`Local folder path on PC for group "${newGroup || oldGroup}" (migrates all member tracks' local paths):`, currentDir)) || '').trim(); } catch {}
                    if (newDir) {
                        const res = window.EveAudioflixLocalize?.updateScopeDir?.('group', oldGroup, newDir);
                        if (res?.ok) ctx.playbackStatus = `Migrated ${res.updatedCount} track path(s) to ${res.targetDir}`;
                    }
                }
                if (newGroup && newGroup !== oldGroup) {
                    window.EveAudioflixState?.renameGroup?.(type, oldGroup, newGroup);
                    ctx.pushHotkeysToBridge();
                }
                ctx.rerender();
                return;
            }
            if (action === 'remove-group') { if (type === 'music') window.EveAudioflixState?.removeMusicGroup?.(actionTarget.dataset.afGroup); else window.EveAudioflixState?.removeSoundboardGroup?.(actionTarget.dataset.afGroup); ctx.rerender(); return; }
            if (action === 'toggle-smart-artists') {
                ctx.smartArtistExpanded = !ctx.smartArtistExpanded;
                ctx.rerender();
                return;
            }
            if (action === 'select-frontend-group') {
                const targetGroup = actionTarget.dataset.afGroup || '';
                const isMusic = type === 'music' || ctx.activeTab === 'music';
                if (isMusic) {
                    const dimension = actionTarget.dataset.afDimension || (
                        targetGroup.startsWith('smart:artist:') ? 'artist'
                            : targetGroup.startsWith('class:') ? 'classifier' : 'group'
                    );
                    const key = dimension === 'artist' ? 'activeFrontendMusicArtist'
                        : dimension === 'classifier' ? 'activeFrontendMusicClassifier'
                            : 'activeFrontendMusicGroup';
                    const patch = { [key]: ctx.state()[key] === targetGroup ? '' : targetGroup, musicViewMode: 'frontend' };
                    if (dimension === 'group') {
                        patch.activeFrontendMusicArtist = '';
                        patch.activeFrontendMusicClassifier = '';
                    } else if (dimension === 'artist') {
                        patch.activeFrontendMusicClassifier = '';
                    }
                    window.EveAudioflixState?.update?.(patch, `audioflix-active-music-${dimension}`);
                } else {
                    const cur = ctx.state().activeFrontendGroup || '';
                    const entries = ctx.frontendGroupEntries ? ctx.frontendGroupEntries('sound') : [];
                    const defaultGroup = (entries[0] || [''])[0];
                    const next = cur === targetGroup ? defaultGroup : targetGroup;
                    window.EveAudioflixState?.update?.({ activeFrontendGroup: next, soundboardViewMode: 'frontend' }, 'audioflix-active-group');
                }
                ctx.pushHotkeysToBridge();
                ctx.rerender();
                return;
            }
            if (action === 'toggle-view-mode') {
                if (type === 'music') {
                    const next = (ctx.state().musicViewMode || 'backend') === 'frontend' ? 'backend' : 'frontend';
                    window.EveAudioflixState?.update?.({ musicViewMode: next }, 'audioflix-music-view-mode');
                } else {
                    const next = (ctx.state().soundboardViewMode || 'backend') === 'frontend' ? 'backend' : 'frontend';
                    window.EveAudioflixState?.update?.({ soundboardViewMode: next }, 'audioflix-view-mode');
                    ctx.pushHotkeysToBridge();
                }
                ctx.rerender(); return;
            }
            if (action === 'play-music-group') {
                const { name, items } = ctx.frontendActiveGroup('music');
                if (items && items.length) {
                    const prev = ctx.activeMusicQueue || {};
                    let ids = items.map(it => it.id);
                    // Starting a group with shuffle already armed begins on a random order.
                    if (prev.shuffle) ids = ctx.shuffleQueue(ids);
                    ctx.activeMusicQueue = {
                        groupName: name,
                        items: ids,
                        currentIndex: 0,
                        isPlaying: true,
                        shuffle: prev.shuffle === true,
                        loop: prev.loop === true
                    };
                    try { await ctx.playQueueIndex(0); } catch (err) { ctx.playbackStatus = err.message || 'Playback failed'; }
                    ctx.rerender();
                }
                return;
            }
            if (action === 'open-queue-view') {
                // Queue-wide internal view: toggles manually open/closed on button press.
                if (window.EveAudioflixAudio?.isInternalViewOpen?.()) {
                    window.EveAudioflixAudio?.hideInternalView?.();
                    ctx.rerender();
                    return;
                }
                await ctx.waitForQueueTransition?.();
                const { name, items } = ctx.frontendActiveGroup('music');
                if (!items?.length) return;
                const prev = ctx.activeMusicQueue || {};
                const running = prev.isPlaying && prev.items?.length && prev.groupName === name;
                if (!running) {
                    ctx.invalidateQueueRun?.();
                    let ids = items.map((it) => it.id);
                    if (prev.shuffle) ids = ctx.shuffleQueue(ids);
                    ctx.activeMusicQueue = {
                        groupName: name, items: ids, currentIndex: 0, isPlaying: true,
                        shuffle: prev.shuffle === true, loop: prev.loop === true
                    };
                }
                const q = ctx.activeMusicQueue;
                const track = ctx.findItem('music', q.items[q.currentIndex]);
                if (track) {
                    try { await window.EveAudioflixAudio?.openInternalView?.(track); }
                    catch (err) { ctx.playbackStatus = err.message || 'Could not open the queue view.'; }
                }
                window.EveAudioflixAudio?.syncQueueView?.();
                ctx.rerender();
                return;
            }
            if (action === 'stop-music-group') {
                const prev = ctx.activeMusicQueue || {};
                ctx.invalidateQueueRun?.();
                // Keep the shuffle/loop preferences armed for the next Play Group.
                ctx.activeMusicQueue = { groupName: '', items: [], currentIndex: -1, isPlaying: false, shuffle: prev.shuffle === true, loop: prev.loop === true };
                await window.EveAudioflixAudio?.stopAll?.();
                ctx.rerender();
                return;
            }
            if (action === 'shuffle-music-group') {
                // Shuffle Order: the playing track becomes #1 and the rest is randomized.
                const q = ctx.activeMusicQueue || {};
                ctx.invalidateQueueRun?.();
                if (!q.items?.length) { ctx.activeMusicQueue = { ...q, shuffle: !q.shuffle }; ctx.rerender(); return; }
                const currentId = q.items[q.currentIndex] || q.items[0];
                const rest = ctx.shuffleQueue(q.items.filter(id => id !== currentId));
                ctx.activeMusicQueue = { ...q, items: [currentId, ...rest], currentIndex: 0, shuffle: true };
                ctx.playbackStatus = `Shuffled — now playing #1 of ${rest.length + 1}.`;
                ctx.rerender();
                return;
            }
            if (action === 'loop-music-group') {
                const q = ctx.activeMusicQueue || {};
                const loop = !(q.loop === true);
                ctx.activeMusicQueue = { ...q, loop };
                ctx.playbackStatus = loop
                    ? (q.shuffle ? 'Loop on — a new shuffle order starts each lap.' : 'Loop on — the group restarts from #1.')
                    : 'Loop off.';
                ctx.rerender();
                return;
            }
            if (action === 'rename-folder-prompt') {
                const oldFolder = actionTarget.dataset.afFolder;
                let newFolder = '';
                try { newFolder = String((await window.showPrompt?.(`Rename folder tag "${oldFolder}":`, oldFolder)) || '').trim(); } catch {}
                const currentDir = window.EveAudioflixLocalize?.getScopeDir?.('folder', oldFolder) || '';
                let newDir = '';
                try { newDir = String((await window.showPrompt?.(`Local folder path on PC for folder "${newFolder || oldFolder}" (migrates all member tracks' local paths):`, currentDir)) || '').trim(); } catch {}
                if (newDir) {
                    const res = window.EveAudioflixLocalize?.updateScopeDir?.('folder', oldFolder, newDir);
                    if (res?.ok) ctx.playbackStatus = `Migrated ${res.updatedCount} track path(s) to ${res.targetDir}`;
                }
                if (newFolder && newFolder !== oldFolder) {
                    window.EveAudioflixState?.renameMusicFolder?.(oldFolder, newFolder);
                }
                ctx.rerender();
                return;
            }
            if (action === 'delete-folder') {
                const folderName = actionTarget.dataset.afFolder;
                window.EveAudioflixState?.deleteMusicFolder?.(folderName);
                ctx.rerender();
                return;
            }
            if (action === 'select-playlist-mode') {
                const mode = actionTarget.dataset.afMode || 'youtube';
                ctx.playlistImportMode = mode;
                ctx.rerender();
                return;
            }
            if (action === 'sync-music-port-folder') {
                const folder = actionTarget.dataset.afFolder;
                if (folder && window.EveAudioflixLocalize?.syncMusicPortFolder) {
                    ctx.playbackStatus = `Syncing folder "${folder}"...`; ctx.rerender();
                    window.EveAudioflixLocalize.syncMusicPortFolder(folder).then(res => {
                        ctx.playbackStatus = res.ok
                            ? (res.reason || `Synced folder "${res.folder}".`)
                            : (res.reason || 'Folder sync failed.');
                        ctx.rerender();
                    });
                }
                return;
            }
            if (action === 'toggle-sync-playlist-form') {
                const group = actionTarget.dataset.afGroup || '';
                const curr = ctx.syncPlaylistFormOpen || {};
                if (curr.open && curr.group === group) {
                    ctx.syncPlaylistFormOpen = { open: false, group: '' };
                } else {
                    ctx.syncPlaylistFormOpen = { open: true, group };
                }
                ctx.rerender();
                return;
            }
            if (action === 'toggle-playlist-link-form') {
                const group = actionTarget.dataset.afGroup || '';
                const curr = ctx.playlistLinkFormOpen || {};
                ctx.playlistLinkFormOpen = (curr.open && curr.group === group) ? { open: false, group: '' } : { open: true, group };
                ctx.rerender();
                return;
            }
            if (action === 'cancel-sync-form') {
                ctx.syncPlaylistFormOpen = { open: false, group: '' };
                ctx.rerender();
                return;
            }
            if (action === 'sync-all-playlists' || action === 'sync-playlists') {
                const PL = window.EveAudioflixPlaylists;
                if (!PL) return;
                ctx.playbackStatus = 'Syncing playlists...'; ctx.rerender();
                let added = 0, missing = 0, restored = 0, failure = '';
                for (const connection of PL.connections()) {
                    const res = await PL.syncPlaylist(connection.id, true);
                    if (res.ok) { added += res.added || 0; missing += res.missing || 0; restored += res.restored || 0; }
                    else failure = res.reason || 'Sync failed.';
                }
                ctx.playbackStatus = failure || `Playlists synced — ${added} added, ${restored} back, ${missing} greyed (removed upstream).`;
                ctx.rerender();
                return;
            }
            if (action === 'merge-duplicate') {
                const primaryId = actionTarget.dataset.afId;
                const dupId = actionTarget.dataset.afDupid;
                const itemType = actionTarget.dataset.afType || 'sound';
                const targetFolder = actionTarget.closest('.audioflix-info-body')?.querySelector('input[name="folder"]')?.value || '';
                const res = window.EveAudioflixDuplicates?.mergeDuplicates?.(itemType, primaryId, [dupId], targetFolder);
                if (res?.ok) {
                    ctx.playbackStatus = res.dualSource
                        ? `Merged — this track now carries both a local file and an online URL.`
                        : `Merged duplicate into this item (groups combined, duplicate removed).`;
                    ctx.activeInfoItem = ctx.state()[itemType === 'music' ? 'music' : 'soundboard']?.find(it => it.id === primaryId) || null;
                } else {
                    ctx.playbackStatus = res?.reason || 'Merge failed';
                }
                ctx.rerender();
                return;
            }
            if (action === 'keep-both-duplicate') {
                const aId = actionTarget.dataset.afId;
                const bId = actionTarget.dataset.afDupid;
                const res = window.EveAudioflixDuplicates?.dismissDuplicate?.(aId, bId);
                ctx.playbackStatus = res?.ok ? 'Keeping both — duplicate notice dismissed for this pair.' : 'Could not dismiss the duplicate.';
                ctx.rerender();
                return;
            }
            if (action === 'keep-playlist-track') {
                const PL = window.EveAudioflixPlaylists;
                if (!PL) return;
                let folder = '';
                try { folder = String((await window.showPrompt?.('This track left the upstream playlist. Folder to keep it in (blank = leave where it is):', '')) || '').trim(); } catch {}
                PL.detachTrack(id, folder ? { folder } : {});
                ctx.playbackStatus = 'Kept in EveOS — it no longer follows that playlist.';
                ctx.rerender();
                return;
            }
            if (action === 'portify-fsport') {
                const nickname = actionTarget.dataset.afNickname || 'Sound folder';
                let folderPath = '';
                try { folderPath = String((await window.showPrompt?.(`Enter the folder path for "${nickname}" so it saves with your datapack (localhost loads it directly — no re-picking on restore):`, '')) || '').trim(); } catch {}
                if (folderPath) {
                    window.EveAudioflixState?.addPort?.({ id, nickname, path: folderPath });
                    // A GRANTED folder keeps its handle (still serverless on file://); a dead stub goes.
                    const rest = (window.EveAudioflixState?.ensure?.().browserFolders || []).filter((f) => f.id !== id);
                    window.EveAudioflixState?.update?.({ browserFolders: rest }, 'audioflix-browser-folders');
                    if (actionTarget.dataset.afGranted !== '1') try { await window.EveAudioflixFsPorts?.removeFolder?.(id); } catch {}
                    ctx.playbackStatus = `Saved "${nickname}" as a path Port — its path now travels with backups.`;
                }
                ctx.loadPortedSounds();
                return;
            }
            if (action === 'remove-port') { window.EveAudioflixState?.removePort?.(id); }
            if (['remove-port', 'link-fsport', 'regrant-fsport', 'add-fsport', 'remove-fsport', 'reconnect-fsports'].includes(action)) {
                const status = await window.EveAudioflixFsPorts?.handleAction?.(action, id, actionTarget);
                if (status) ctx.playbackStatus = status;
                ctx.loadPortedSounds();
                return;
            }
            if (action === 'pause') { window.EveAudioflixAudio?.pause?.(); return; }
            if (action === 'play') { if (item) try {
                ctx.stopRepeater(id);
                if (type === 'music' && ctx.activeMusicQueue?.items?.includes(id)) {
                    ctx.invalidateQueueRun?.();
                    ctx.activeMusicQueue = { ...ctx.activeMusicQueue, currentIndex: ctx.activeMusicQueue.items.indexOf(id), isPlaying: true };
                    window.EveAudioflixAudio?.syncQueueView?.();
                }
                const active = window.EveAudioflixAudio?.getPlaybackState?.();
                await stopItemPlayback(id, active?.browserOnly === true && String(active.item?.id || active.item?.url || '') === String(id || ''));
                await window.EveAudioflixAudio?.playItem?.({ ...item, type: type || item.type });
            } catch (err) { ctx.playbackStatus = err.message || 'Playback failed'; ctx.rerender(); } return; }
            if (action === 'remove') { window.EveAudioflixState?.removeItem?.(type, id); ctx.rerender(); return; }
            if (action === 'select-output') { try { await window.EveAudioflixAudio?.selectOutput?.(); } catch (err) { ctx.playbackStatus = err.message || 'Output selection failed'; } ctx.rerender(); return; }
            if (action === 'unlock-output-names') {
                try { const ok = await window.EveAudioflixAudio?.unlockDeviceLabels?.(); ctx.playbackStatus = ok ? 'Output access granted.' : 'Output access still blocked here.'; }
                catch (err) { ctx.playbackStatus = err.message || 'Device name unlock failed'; } ctx.rerender(); return;
            }
            if (action === 'local-only') {
                window.EveAudioflixGemini?.setVoicePortEnabled?.(false); window.EveAudioflixGemini?.setMonitorEnabled?.(true); window.EveAudioflixState?.update?.({ routeMode: 'browser' }, 'audioflix-local-playback');
                ctx.playbackStatus = 'Local only mode active'; ctx.rerender(); return;
            }
            if (action === 'open-windows-mixer') { try { window.open('ms-settings:apps-volume', '_blank', 'noopener'); } catch(e){} ctx.playbackStatus = 'Open Windows Volume mixer...'; ctx.rerender(); return; }
            if (action === 'mark-windows-route') { window.EveAudioflixState?.update?.({ routeMode: 'manual', geminiVoicePortEnabled: true }, 'audioflix-windows-mixer-route'); ctx.playbackStatus = 'Windows mixer route marked'; ctx.rerender(); return; }
            if (action === 'refresh-native-devices') {
                try { const p = await window.EveAudioflixNative?.listSystemOutputs?.(true); ctx.playbackStatus = p?.message || 'Native outputs refreshed'; } catch (err) { ctx.playbackStatus = err.message || 'Native output refresh failed'; } ctx.rerender(); return;
            }
            if (action === 'toggle-native-bridge') {
                const next = ctx.state().nativeBridgeEnabled !== true; window.EveAudioflixNative?.setNativeBridgeEnabled?.(next);
                const u = ctx.state(); ctx.playbackStatus = next && u.nativeBridgeEnabled ? `Native route enabled: ${u.nativeOutputLabel}` : 'Native route disabled';
                ctx.pushHotkeysToBridge(); ctx.rerender(); return;
            }
            if (action === 'arm-cable') {
                try {
                    let dev = await window.EveAudioflixAudio?.listOutputs?.() || [], c = await window.EveAudioflixRouting?.findCableDevice?.() || dev.find(d => /(?:cable input|vb-audio virtual cable|vb-cable)/i.test(d.label || ''));
                    if (!c && window.EveAudioflixRouting?.hasAnonymousOutputs?.(dev) && await window.EveAudioflixAudio?.unlockDeviceLabels?.()) {
                        dev = await window.EveAudioflixAudio?.listOutputs?.() || [];
                        c = await window.EveAudioflixRouting?.findCableDevice?.() || dev.find(d => /(?:cable input|vb-audio virtual cable|vb-cable)/i.test(d.label || ''));
                    }
                    if (!c) { ctx.playbackStatus = 'CABLE Input not visible yet'; ctx.rerender(); return; }
                    await window.EveAudioflixAudio?.setOutputById?.(c.deviceId, c.label || 'CABLE Input'); window.EveAudioflixGemini?.setVoicePortEnabled?.(true); ctx.playbackStatus = `Gemini voice port armed through ${c.label || 'CABLE Input'}`;
                } catch (err) { ctx.playbackStatus = err.message || 'CABLE Input preset failed'; } ctx.rerender(); return;
            }
            if (action === 'test-signal') {
                try {
                    if (window.EveAudioflixGemini?.playVoiceRouteTest) ctx.playbackStatus = (await window.EveAudioflixGemini.playVoiceRouteTest())?.native ? 'Playing native bridge route test' : 'Playing Gemini WebAudio route test';
                    else { await window.EveAudioflixAudio?.playTestSignal?.(); ctx.playbackStatus = 'Playing Audioflix test signal'; }
                } catch (err) { ctx.playbackStatus = err.message || 'Test signal failed'; } ctx.rerender(); return;
            }
            if (action === 'copy-route-status') { try { await window.EveAudioflixRouting?.copyRouteStatus?.(ctx.playbackStatus); ctx.playbackStatus = 'Routing status copied'; } catch (err) { ctx.playbackStatus = err.message || 'Copy status failed'; } ctx.rerender(); return; }
            if (action === 'toggle-gemini-port') { const en = window.EveAudioflixGemini?.setVoicePortEnabled?.(!ctx.state().geminiVoicePortEnabled); ctx.playbackStatus = en ? 'Selective route armed' : 'Selective route disabled'; ctx.rerender(); return; }
            if (action === 'toggle-gemini-monitor') { window.EveAudioflixGemini?.setMonitorEnabled?.(ctx.state().geminiVoiceMonitorEnabled === false); ctx.rerender(); return; }
            if (action === 'toggle-gemini-mode') {
                const next = ctx.state().geminiConversationMode === 'text-brain-live-voice' ? 'direct-live' : 'text-brain-live-voice'; window.EveAudioflixGemini?.setConversationMode?.(next);
                ctx.playbackStatus = next === 'text-brain-live-voice' ? 'Mode 2 enabled.' : 'Direct Live mode enabled.'; ctx.rerender(); return;
            }
            if (action === 'clear-gemini-events') { window.EveAudioflixState?.clearGeminiAudioEvents?.(); ctx.playbackStatus = 'Gemini event counter cleared'; ctx.rerender(); return; }
            if (action === 'trigger-wpl-file-picker') {
                window.EveAudioflixUiPicker?.instance?.open?.();
                return;
            }
            if (action === 'toggle-import-form') {
                ctx.importFormOpen = !ctx.importFormOpen;
                if (ctx.importFormOpen) {
                    ctx.localizeFormOpen = { open: false, scope: 'library', key: '' };
                    ctx.musicPortFormOpen = false;
                }
                ctx.rerender();
                return;
            }
            for (const handler of providerActions) if (await handler(actionTarget, action)) return;
            if (await nexusActions(actionTarget, action)) return;
            // Localization / remaining nexus-panel actions live in a sibling module.
            if (await localizeActions(actionTarget, action)) return;
        }
        const handleForm = window.EveAudioflixUiForms.create(ctx);
        return { handleAction, handleForm };
    };
    ns.ready = true;
})();
