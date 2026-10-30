window.EveAudioflix = window.EveAudioflix || {};
(function () {
    'use strict';
    const ns = window.EveAudioflix;
    if (ns.ready) return;
    let overlay = null, activeTab = 'soundboard', lastTab = 'soundboard', playbackStatus = 'Idle', routingOpen = false, fullscreenOn = false, settingsOpen = false, addFormOpen = { sound: false, music: false }, portsOpen = false, groupsOpen = { sound: false, music: false }, foldersOpen = { music: false }, portedSounds = [], portedCatalogReady = false, fsPortFolders = [], deadServerPorts = new Set(), collapsedGroups = {}, activeRepeaters = {}, activeInfoItem = null, activeInfoType = null, deleteConfirmId = '';
    let activeMusicQueue = { groupName: '', items: [], currentIndex: -1, isPlaying: false, shuffle: false, loop: false }, repeatCurrent = false;
    let queueTransition = Promise.resolve(), queueRunId = 0;
    const shared = window.EveAudioflixUiShared;
    let lastRenderedRevision = -1;
    if (!shared?.ready) throw new Error('Audioflix UI shared module loaded out of order.');
    const { shuffleQueue, hotkeyComboIssue, hotkeyComboFromEvent, playSvg, closeSvg, stopSvg, layerPlaySvg, viewSvg, cogSvg } = shared;
    let nativeHotkeysLive = false, hotkeyController = null;
    const state = () => window.EveAudioflixState?.ensure?.() || {};
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const setButtonExpanded = (exp) => document.querySelectorAll('.topbar-audioflix-btn').forEach(b => b.setAttribute('aria-expanded', exp ? 'true' : 'false'));
    const itemMeta = (item) => [...new Set([item.artist, item.card, item.folder, item.category].filter(Boolean))].join(' / ') || 'No extra metadata yet';
    const internalViewButton = (item, type, wide = false) => type === 'music' && /^https?:\/\//i.test(String(item?.url || '')) ? `<button type="button" class="${wide ? 'audioflix-info-close-action' : 'audioflix-icon-btn'}" data-af-action="internal-view" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="Open inside EveOS">${wide ? 'Internal View' : viewSvg}</button>` : '';
    const groupKey = (item, type) => String((type === 'music' ? (item.folder || item.card) : item.category) || '').trim() || 'Ungrouped';
    const formatDuration = (sec) => sec === undefined ? 'Loading...' : (sec === null || isNaN(sec) ? 'Unavailable' : (sec === Infinity ? 'Stream' : (sec / 60 >= 1 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : `${Math.floor(sec)}.${String(Math.floor((sec % 1) * 100)).padStart(2, '0')}s`)));
    let importFormOpen = false, playlistImportMode = 'youtube';
    let importFormValues = { wplUrl: '', wplFolder: '', wplFileContent: '' };
    let localizeFormOpen = { open: false, scope: 'library', key: '' };
    let syncPlaylistFormOpen = { open: false, group: '' };
    let playlistLinkFormOpen = { open: false, group: '' };
    let missingListOpen = { open: false, scope: '', key: '' };
    let smartArtistExpanded = false;
    let musicPortFormOpen = false;
    let groupPathsOpen = { open: false, key: '' };
    let groupPathsScopesOpen = {};
    // Localization UI renderers live in a sibling module, reading this view's flags via getters.
    const uiLoc = window.EveAudioflixUiLocalize.create({
        esc: (v) => esc(v),
        closeSvg,
        findItem: (t, id) => findItem(t, id),
        getLocalizeFormOpen: () => localizeFormOpen,
        getMissingListOpen: () => missingListOpen,
        getGroupPathsOpen: () => groupPathsOpen,
        getGroupPathsScopesOpen: () => groupPathsScopesOpen,
        getFsPortFolders: () => fsPortFolders
    });
    // Nexus Audio Link search panel (music + soundboard, backend + frontend).
    let nexusState = { open: false, type: 'music', query: '', facet: '' };
    const uiNexus = window.EveAudioflixNexusUi.create({
        esc: (v) => esc(v),
        getNexusState: () => nexusState,
        getPorted: () => portedSounds,
        // Late-bound: uiClass is created just below, so reach it lazily.
        renderClassifierChips: (facet, entries) => uiClass.renderNexusChips(facet, entries)
    });
    // Classifier system (automatic time-filter / group-rank + manual labels).
    let classifierManagerOpen = false;
    let classifierDetailId = '';
    let classifierRowOpen = false;
    const uiClass = window.EveAudioflixClassifiersUi.create({
        esc: (v) => esc(v),
        closeSvg,
        getManagerOpen: () => classifierManagerOpen,
        getManagerDetailId: () => classifierDetailId,
        getFrontendOpen: () => classifierRowOpen
    });
    // Settings (cog) modal lives in a sibling module. Helpers are late-bound arrows: this factory
    // runs before the `const` helpers below exist (temporal dead zone otherwise).
    const uiModal = window.EveAudioflixUiModal.create({
        esc, closeSvg, state, uiLoc, uiClass,
        formatDuration: (v) => formatDuration(v),
        isItemExposed: (it, t) => isItemExposed(it, t),
        groupsOf: (id, t) => groupsOf(id, t),
        allGroups: (t) => allGroups(t),
        internalViewButton: (it, t, w) => internalViewButton(it, t, w),
        findItem: (t, id) => findItem(t, id),
        renderLocalizeForm: () => renderLocalizeForm(),
        getActiveRepeaters: () => activeRepeaters,
        getLocalizeFormOpen: () => localizeFormOpen,
        getDeleteConfirmId: () => deleteConfirmId
    });
    const renderInfoModal = (item, type) => uiModal.renderInfoModal(item, type);
    const renderGroupAssign = (item, type) => uiModal.renderGroupAssign(item, type);

    async function loadPortedSounds() {
        await window.EveAudioflixFsPorts?.reconcile?.().catch?.(() => false);
        const snapshot = state(), base = (window.location.origin && !window.location.origin.startsWith('file:')) ? window.location.origin.replace('localhost', '127.0.0.1') : 'http://127.0.0.1:8765';
        deadServerPorts = new Set();
        try {
            const res = await window.EveAudioflixFsPorts?.loadPortedSounds?.(snapshot, base, deadServerPorts);
            if (res) { portedSounds = res.fetched; fsPortFolders = res.fsPortFolders; portedCatalogReady = true; }
        } catch (err) { console.error('Failed to load ported sounds:', err); }
        if (portedCatalogReady) pushHotkeysToBridge();
        rerender();
    }

    const pushHotkeysToBridge = (options) => hotkeyController?.syncHotkeys?.(options) || Promise.resolve({ ok: false, pending: true });

    // Overlay construction + delegated event wiring live in a sibling module (late-bound ctx).
    const uiOverlay = window.EveAudioflixUiOverlay.create({
        state, rerender: () => rerender(), close: () => close(),
        handleAction: (t, e) => handleAction(t, e), handleForm: (f) => handleForm(f),
        handleHotkey: (e) => handleHotkey(e), startHotkeyFeedbackPoll: () => startHotkeyFeedbackPoll(),
        renderPanel: () => renderPanel(), shuffleQueue: (ids) => shuffleQueue(ids),
        findItem: (t, id) => findItem(t, id), uiNexus, uiClass,
        pushHotkeysToBridge: () => pushHotkeysToBridge(), hotkeyComboIssue: (c) => hotkeyComboIssue(c),
        hotkeyComboFromEvent: (e) => hotkeyComboFromEvent(e),
        // Live accessors over this view's mutable state (the overlay module holds none of its own).
        view: {
            get overlay() { return overlay; }, set overlay(v) { overlay = v; },
            get portedSounds() { return portedSounds; },
            get activeMusicQueue() { return activeMusicQueue; }, set activeMusicQueue(v) { const prev = activeMusicQueue; activeMusicQueue = v; window.EveAudioflixQueueMembership?.noteWrite?.(prev, v); },
            get nexusState() { return nexusState; }, set nexusState(v) { nexusState = v; },
            get importFormValues() { return importFormValues; }, set importFormValues(v) { importFormValues = v; },
            get playbackStatus() { return playbackStatus; }, set playbackStatus(v) { playbackStatus = v; },
            get activeInfoItem() { return activeInfoItem; }, set activeInfoItem(v) { activeInfoItem = v; }
        }
    });
    const ensureOverlay = () => uiOverlay();
    let playQueueIndex;
    const queueRuntime = window.EveAudioflixQueueCompletion.createRuntime({
        state, queue: () => activeMusicQueue, playIndex: (index) => playQueueIndex(index),
        getRun: () => queueRunId, setRun: (value) => { queueRunId = value; }, snapshot: () => ns.queueConnection?.snapshot?.()
    });
    const { trackAt: queueTrackAt, invalidateRun: invalidateQueueRun, restart: restartQueueCurrent, complete: completeQueue } = queueRuntime;
    playQueueIndex = async (index) => {
        if (!activeMusicQueue.items?.length) return;
        let targetIndex = Number(index);
        if (isNaN(targetIndex)) targetIndex = 0;
        if (targetIndex >= activeMusicQueue.items.length) {
            if (activeMusicQueue.loop === true) {
                targetIndex = 0;
                if (activeMusicQueue.shuffle === true) {
                    const currentId = activeMusicQueue.items[activeMusicQueue.currentIndex];
                    const rest = shuffleQueue(activeMusicQueue.items.filter(id => id !== currentId));
                    activeMusicQueue.items = [...rest, currentId];
                }
            } else {
                queueRuntime.finish();
                return;
            }
        } else if (targetIndex < 0) {
            targetIndex = activeMusicQueue.loop === true ? activeMusicQueue.items.length - 1 : 0;
        }
        const runId = ++queueRunId;
        queueTransition = queueTransition.catch(() => {}).then(async () => {
            if (runId !== queueRunId) return;
            const finish = window.EveAudioflixDiagnostics?.span?.('queue:start');
            const attempts = activeMusicQueue.items.length, startingIndex = activeMusicQueue.currentIndex;
            let didStart = false;
            for (let attempt = 0; attempt < attempts && runId === queueRunId; attempt += 1) {
                activeMusicQueue.currentIndex = targetIndex;
                const track = queueTrackAt(targetIndex);
                try {
                    if (!track) throw new Error('Queue track is no longer in the library.');
                    const started = window.EveAudioflixAudio?.isInternalViewOpen?.()
                        ? await window.EveAudioflixAudio.openInternalView(track)
                        : await window.EveAudioflixAudio.playItem(track);
                    // Superseded start: cancellation, not a broken track. Restore the authoritative index, no skip.
                    if (started === false) { activeMusicQueue.currentIndex = startingIndex; finish?.(false); window.EveAudioflixAudio?.syncQueueView?.(); rerenderPlayback(); return; }
                    didStart = true; break;
                } catch (err) {
                    playbackStatus = `Skipped ${track?.title || 'unavailable track'}: ${err?.message || 'Playback failed'}`;
                    window.EveAudioflixDiagnostics?.record?.('queue:skipped-start', 0, { error: true });
                    console.warn('[Audioflix]', playbackStatus);
                    targetIndex += 1;
                    if (targetIndex >= activeMusicQueue.items.length) {
                        if (activeMusicQueue.loop) targetIndex = 0; else break;
                    }
                    continue;
                }
            }
            if (runId !== queueRunId) { finish?.(true); return; }
            activeMusicQueue.isPlaying = didStart; finish?.(!didStart); if (didStart) window.EveAudioflixSpotifyQueueHandoff?.arm?.(activeMusicQueue, queueTrackAt).catch(() => {});
            window.EveAudioflixAudio?.syncQueueView?.();
            rerenderPlayback();
        });
        return queueTransition;
    };
    const openQueueDetails = () => { const track = queueTrackAt(activeMusicQueue.currentIndex) || window.EveAudioflixAudio?.getPlaybackState?.()?.item; if (!track?.id) return false; activeTab = 'music'; activeInfoItem = findItem('music', track.id) || track; activeInfoType = 'music'; deleteConfirmId = ''; open(); overlay?.classList.add('audioflix-info-over-internal'); rerenderModal(); return true; };
    window.EveAudioflixUiPicker.instance = window.EveAudioflixUiPicker.create({
        rerender: () => rerender(),
        view: {
            get importFormValues() { return importFormValues; }, set importFormValues(v) { importFormValues = v; },
            get playbackStatus() { return playbackStatus; }, set playbackStatus(v) { playbackStatus = v; }
        }
    });
    const allGroups = (type = 'sound') => (type === 'music' ? state().musicGroups : state().soundboardGroups) || [];
    const groupsOf = (id, type = 'sound') => {
        const map = type === 'music' ? state().musicGroupMap : state().soundGroupMap;
        return (map?.[id] || []).filter((g) => allGroups(type).includes(g));
    };
    const isItemExposed = (item, type = 'sound') => {
        if (type === 'music') return item.exposed === true || groupsOf(item.id, 'music').length > 0;
        return groupsOf(item.id, 'sound').length > 0 || (item.isPorted ? state().exposedPortedSounds?.[item.id] === true : item.exposed === true);
    };
    const groupTags = (item, gs = groupsOf(item.id, item?.type || 'music')) => window.EveAudioflixGroupTreeUi?.renderTags?.({ type: item?.type || 'music', groups: gs, state: state(), esc }) || '';

    // Card / grid / frontend renderers live in a sibling module; they reach this view's helpers
    // and mutable flags through this ctx bag (frontendActiveGroup is also handed to the actions ctx).
    const uiRender = window.EveAudioflixUiRender.create({
        state, esc, itemMeta, groupKey, groupTags, internalViewButton,
        isItemExposed: (it, t) => isItemExposed(it, t),
        allGroups: (t) => allGroups(t),
        groupsOf: (id, t) => groupsOf(id, t),
        stopSvg, playSvg, layerPlaySvg, cogSvg, closeSvg,
        getPorted: () => portedSounds,
        getActiveRepeaters: () => activeRepeaters,
        getActiveMusicQueue: () => activeMusicQueue,
        renderClassifierRow: (activeKey, entries) => uiClass.renderFrontendRow(activeKey, entries),
        classifierEntries: (items) => window.EveAudioflixClassifiers?.selectableEntries?.(items) || [],
        getCollapsedGroups: () => collapsedGroups,
        get smartArtistExpanded() { return smartArtistExpanded; }
    });
    const { frontendGroupEntries, frontendActiveGroup, renderItemCard, renderItems, renderFrontendActive, renderFrontendMusicActive } = uiRender;

    const renderForm = (type, m = type === 'music') => `<form class="audioflix-form" data-af-form="${m ? 'music' : 'sound'}"><label><span>${m ? 'Track Title' : 'Sound Name'}</span><input name="title" required></label><label class="audioflix-wide-field"><span>URL / Path</span><input name="url" required></label><label><span>${m ? 'Artist' : 'Category'}</span><input name="${m ? 'artist' : 'category'}"></label><label><span>${m ? 'Folder' : 'Volume'}</span><input name="${m ? 'folder' : 'volume'}"></label><button type="submit" data-af-action="submit-form">${m ? 'Add Track' : 'Add Sound'}</button></form>`;
    const renderImportPlaylistForm = () => window.EveAudioflixPlaylistImportUi.render({
        mode: playlistImportMode || 'youtube',
        esc,
        values: importFormValues,
        state: state()
    });
    const renderSyncPlaylistForm = (g) => {
        const conn = window.EveAudioflixPlaylists?.getPlaylistForGroup?.(g);
        const currFolder = conn?.folder || 'Music';
        return `<form class="audioflix-form" data-af-form="sync-playlist-form" data-af-group="${esc(g)}" style="margin-top:6px;"><label class="audioflix-wide-field"><span>Target Folder for Synced Songs (leave blank for default "${esc(currFolder)}")</span><input name="folder" value="${esc(currFolder)}" placeholder="${esc(currFolder)}"></label><button type="submit" data-af-action="submit-form">Sync Playlist</button><button type="button" class="audioflix-add-toggle" data-af-action="cancel-sync-form" style="margin-left:8px;">Cancel</button></form>`;
    };
    const renderLocalizeForm = () => uiLoc.renderLocalizeForm();
    const renderMusicPortForm = () => uiLoc.renderMusicPortForm();
    const renderPortsManager = () => window.EveAudioflixFsPorts?.renderPortsManager?.(state(), fsPortFolders, deadServerPorts, esc, closeSvg) || '';
    const uiManagers = window.EveAudioflixUiManagers.create({
        esc, closeSvg, state, uiLoc,
        allGroups: (t) => allGroups(t),
        renderLocalizeForm: () => renderLocalizeForm(),
        renderSyncPlaylistForm: (g) => renderSyncPlaylistForm(g),
        getLocalizeFormOpen: () => localizeFormOpen,
        getSyncPlaylistFormOpen: () => syncPlaylistFormOpen,
        getPlaylistLinkOpen: () => playlistLinkFormOpen,
        getGroupPathsOpen: () => groupPathsOpen,
        getPorted: () => portedSounds
    });
    const renderGroupsManager = (type) => uiManagers.renderGroupsManager(type);
    const renderFoldersManager = () => uiManagers.renderFoldersManager();
    // The toolbar row + its expandable panels live in a sibling module (late-bound ctx).
    const renderAddSection = window.EveAudioflixUiToolbar.create({
        esc, state, uiNexus, uiClass,
        renderForm: (t) => renderForm(t),
        renderImportPlaylistForm: () => renderImportPlaylistForm(),
        renderLocalizeForm: () => renderLocalizeForm(),
        renderMusicPortForm: () => renderMusicPortForm(),
        renderFoldersManager: () => renderFoldersManager(),
        renderGroupsManager: (t) => renderGroupsManager(t),
        renderPortsManager: () => renderPortsManager(),
        getFlags: () => ({ addFormOpen, groupsOpen, foldersOpen, portsOpen, importFormOpen, localizeFormOpen, musicPortFormOpen, classifierManagerOpen, nexusState })
    });
    const uiPanel = window.EveAudioflixUiPanel.create({
        state, esc, closeSvg, hotkeyComboIssue, renderItems, renderAddSection,
        frontendActiveGroup: (type) => frontendActiveGroup(type),
        view: () => ({ activeTab, fullscreenOn, settingsOpen, routingOpen, portedSounds, playbackStatus }),
        tools: () => ({ piano: window.EveAudioflixPianoUi, soundLab: window.EveAudioflixSoundLabUi, routing: window.EveAudioflixRouting, narration: window.EveWorldBookNarrationCompanion }),
        playback: () => ({ queue: uiRender, status: updateStatusDOM, nexus: nexusState, nexusUi: uiNexus }),
        modal: () => renderModalHost()
    });
    const renderPanel = () => uiPanel.render();
    const renderModalHost = () => (activeInfoItem ? renderInfoModal(activeInfoItem, activeInfoType) : '');

    // Opening a song's settings panel used to go through the full rerender below, rebuilding EVERY
    // card's markup for a change that only affects the modal. On a large library that is a long
    // synchronous block, and with the ScriptProcessor capture tap (the file:// fallback, which runs
    // on the main thread) that stall is audible as the song hitching. The modal lives in its own
    // host so it can be swapped on its own.
    function rerenderModal() {
        if (!overlay || overlay.hidden) return;
        const host = overlay.querySelector('.audioflix-modal-host');
        if (!host) return rerender();
        if (activeInfoItem) activeInfoItem = findItem(activeInfoType, activeInfoItem.id) || activeInfoItem;
        const keepScroll = host.querySelector('.audioflix-info-body')?.scrollTop || 0;
        host.innerHTML = renderModalHost();
        const body = host.querySelector('.audioflix-info-body');
        if (body) body.scrollTop = keepScroll;
    }

    function rerender(transient = false) {
        if (!overlay || overlay.hidden || window.EveAudioflixSoundLabUi?.deferOuterRender?.(rerender)) return;
        if (transient === true && uiPanel.transient(overlay)) { updateStatusDOM(); window.EveAudioflixTransport?.sync?.(overlay); return; }
        if (activeInfoItem) activeInfoItem = findItem(activeInfoType, activeInfoItem.id) || activeInfoItem;
        const panel = overlay.querySelector('.audioflix-panel'), scrollTop = (panel && lastTab === activeTab) ? panel.scrollTop : 0, scrollLeft = (panel && lastTab === activeTab) ? panel.scrollLeft : 0;
        const infoBody = overlay.querySelector('.audioflix-info-body'), infoScrollTop = infoBody ? infoBody.scrollTop : 0;
        const nexusScroll = window.EveAudioflixNexusUi?.captureScroll?.(overlay);
        lastTab = activeTab; overlay.innerHTML = renderPanel();
        window.EveAudioflixNexusUi?.restoreScroll?.(overlay, nexusScroll); const newPanel = overlay.querySelector('.audioflix-panel');
        if (newPanel) { newPanel.scrollTop = scrollTop; newPanel.scrollLeft = scrollLeft; }
        const newInfoBody = overlay.querySelector('.audioflix-info-body');
        if (newInfoBody) { newInfoBody.scrollTop = infoScrollTop; }
        window.EveAudioflixAudio?.attachWaveform?.(overlay.querySelector('#audioflix-waveform'));
        window.EveAudioflixTransport?.sync?.(overlay);
        window.EveAudioflixLayerVoices?.render?.(overlay);
        window.EveWorldBookNarrationCompanion?.syncAudioflixSummary?.();
        window.EveAudioflixRouting?.populateOutputSelectors?.(overlay);
        window.EveAudioflixSoundLabUi?.setVisible?.(activeTab === 'soundlab'); window.EveAudioflixPianoUi?.setVisible?.(activeTab === 'piano'); window.EveAudioflixPianoUi?.afterRender?.(overlay);
        window.EveAudioflixSoundLabUi?.afterRender?.(overlay);
        lastRenderedRevision = window.EveAudioflixState?.getRevision?.();
    }

    function rerenderLibrary() { if (!overlay || overlay.hidden || window.EveAudioflixSoundLabUi?.deferOuterRender?.(rerenderLibrary)) return; if (!uiPanel.library?.(overlay)) return rerender(); lastRenderedRevision = window.EveAudioflixState?.getRevision?.(); updateStatusDOM(); }
    const rerenderPlayback = () => uiPanel.playback(overlay);

    const stopRepeater = (itemId) => { if (activeRepeaters[itemId]) { clearInterval(activeRepeaters[itemId].id); delete activeRepeaters[itemId]; rerender(); } };
    const startRepeater = (item, intervalMs, count) => { stopRepeater(item.id); let rem = count; const play = () => Promise.resolve(window.EveAudioflixAudio?.playItem?.(item)).catch(() => {}); play(); if (rem > 0) rem--; const id = setInterval(() => { if (rem === 0) return stopRepeater(item.id); play(); if (rem > 0) rem--; }, intervalMs); activeRepeaters[item.id] = { id, intervalMs, count }; rerender(); };

    const findItem = (type, itemId) => window.EveAudioflixLibraryIndex?.get ? window.EveAudioflixLibraryIndex.get(state(), type).getById(itemId) : ((type === 'music' ? state().music : state().soundboard) || []).find(item => item.id === itemId);

    // Handlers live in sibling modules and reach this view's mutable state through `uiCtx`, so the
    // renderers above keep using the same closure variables unchanged.
    const uiCtx = {
        rerenderTransient: () => rerender(true), rerenderPlayback, rerenderLibrary,
        state, rerender, rerenderModal, pushHotkeysToBridge, loadPortedSounds, findItem, startRepeater, stopRepeater, frontendActiveGroup, frontendGroupEntries, playQueueIndex, toggleGroup: uiRender.toggleGroup,
        setHotkeyBypassed: (desired) => hotkeyController?.setBypassed?.(desired),
        invalidateQueueRun, waitForQueueTransition: () => queueTransition.catch(() => {}),
        get overlay() { return overlay; },
        get portedSounds() { return portedSounds; },
        get activeRepeaters() { return activeRepeaters; }, set activeRepeaters(v) { activeRepeaters = v; },
        get collapsedGroups() { return collapsedGroups; }, set collapsedGroups(v) { collapsedGroups = v; },
        get addFormOpen() { return addFormOpen; }, set addFormOpen(v) { addFormOpen = v; },
        get groupsOpen() { return groupsOpen; }, set groupsOpen(v) { groupsOpen = v; },
        get foldersOpen() { return foldersOpen; }, set foldersOpen(v) { foldersOpen = v; },
        get playbackStatus() { return playbackStatus; }, set playbackStatus(v) { playbackStatus = v; },
        get activeInfoItem() { return activeInfoItem; }, set activeInfoItem(v) { activeInfoItem = v; },
        get activeInfoType() { return activeInfoType; }, set activeInfoType(v) { activeInfoType = v; },
        get deleteConfirmId() { return deleteConfirmId; }, set deleteConfirmId(v) { deleteConfirmId = v; },
        get activeTab() { return activeTab; }, set activeTab(v) { activeTab = v; },
        get routingOpen() { return routingOpen; }, set routingOpen(v) { routingOpen = v; },
        get settingsOpen() { return settingsOpen; }, set settingsOpen(v) { settingsOpen = v; },
        get fullscreenOn() { return fullscreenOn; }, set fullscreenOn(v) { fullscreenOn = v; },
        get portsOpen() { return portsOpen; }, set portsOpen(v) { portsOpen = v; },
        get importFormOpen() { return importFormOpen; }, set importFormOpen(v) { importFormOpen = v; },
        get playlistImportMode() { return playlistImportMode; }, set playlistImportMode(v) { playlistImportMode = v; },
        get importFormValues() { return importFormValues; }, set importFormValues(v) { importFormValues = v; },
        get localizeFormOpen() { return localizeFormOpen; }, set localizeFormOpen(v) { localizeFormOpen = v; },
        get syncPlaylistFormOpen() { return syncPlaylistFormOpen; }, set syncPlaylistFormOpen(v) { syncPlaylistFormOpen = v; },
        get playlistLinkFormOpen() { return playlistLinkFormOpen; }, set playlistLinkFormOpen(v) { playlistLinkFormOpen = v; },
        get missingListOpen() { return missingListOpen; }, set missingListOpen(v) { missingListOpen = v; },
        get smartArtistExpanded() { return smartArtistExpanded; }, set smartArtistExpanded(v) { smartArtistExpanded = v; },
        get classifierManagerOpen() { return classifierManagerOpen; }, set classifierManagerOpen(v) { classifierManagerOpen = v; },
        get classifierDetailId() { return classifierDetailId; }, set classifierDetailId(v) { classifierDetailId = v; },
        get classifierRowOpen() { return classifierRowOpen; }, set classifierRowOpen(v) { classifierRowOpen = v; },
        get musicPortFormOpen() { return musicPortFormOpen; }, set musicPortFormOpen(v) { musicPortFormOpen = v; },
        get open() { return open; },
        get close() { return close; },
        get groupPathsScopesOpen() { return groupPathsScopesOpen; }, set groupPathsScopesOpen(v) { groupPathsScopesOpen = v; },
        get groupPathsOpen() { return groupPathsOpen; }, set groupPathsOpen(v) { groupPathsOpen = v; },
        get nexusState() { return nexusState; }, set nexusState(v) { nexusState = v; },
        get activeMusicQueue() { return activeMusicQueue; }, set activeMusicQueue(v) { const prev = activeMusicQueue; activeMusicQueue = v; window.EveAudioflixQueueMembership?.noteWrite?.(prev, v); },
        shuffleQueue: (ids) => shuffleQueue(ids),
        hotkeySoundItems: () => frontendActiveGroup('sound').items,
        hotkeyCatalogReady: () => portedCatalogReady,
        get nativeHotkeysLive() { return nativeHotkeysLive; }, set nativeHotkeysLive(v) { nativeHotkeysLive = v; }
    };
    const { handleAction, handleForm } = window.EveAudioflixUiActions.create(uiCtx);
    hotkeyController = window.EveAudioflixUiHotkeys.create(uiCtx);
    const { startHotkeyFeedbackPoll, stopHotkeyFeedbackPoll, handleHotkey } = hotkeyController;
    const refreshMountedTool = () => { if (!overlay || overlay.hidden || !['piano', 'soundlab'].includes(activeTab)) return false; updateStatusDOM(); window.EveAudioflixTransport?.sync?.(overlay); window.EveAudioflixSoundLabUi?.setVisible?.(activeTab === 'soundlab'); window.EveAudioflixPianoUi?.setVisible?.(activeTab === 'piano'); return true; };
    const open = () => { ensureOverlay(); overlay.hidden = false; overlay.classList.toggle('is-fullscreen', fullscreenOn); setButtonExpanded(true); rerender(); loadPortedSounds().then(() => window.EveAudioflixLocalize?.auditScopeDiskStatus?.('library', '')).then(() => { if (!refreshMountedTool()) rerender(); }).catch(() => {}); startHotkeyFeedbackPoll(); };
    const close = () => { if (overlay) { overlay.hidden = true; overlay.classList.remove('audioflix-info-over-internal', 'audioflix-nexus-over-internal'); } window.EveAudioflixSoundLabUi?.setVisible?.(false); window.EveAudioflixPianoUi?.setVisible?.(false); window.EveAudioflixAudio?.attachWaveform?.(null); window.EveAudioflixLinks?.clearPendingScope?.(); setButtonExpanded(false); };
    const openNexus = (type = 'music', forceOpen = false) => {
        const nextType = type === 'sound' ? 'sound' : 'music';
        if (!forceOpen && nexusState.open && nexusState.type === nextType) {
            nexusState = { ...nexusState, open: false };
            overlay?.classList.remove('audioflix-nexus-over-internal');
            rerender(true); return false;
        }
        activeTab = nextType === 'sound' ? 'soundboard' : 'music';
        nexusState = { open: true, type: nextType, query: '', facet: '', selectedIds: [] };
        if (!overlay || overlay.hidden) open(); // no re-run of port reload/disk audit (2 late full rerenders)
        overlay?.classList.add('audioflix-nexus-over-internal');
        rerender(true); return true;
    };

    function updateStatusDOM() {
        if (!overlay || overlay.hidden) return;
        const waveLabel = overlay.querySelector('.audioflix-player span'), statusCardStrong = overlay.querySelector('.audioflix-status-signal-value');
        if (waveLabel) waveLabel.textContent = playbackStatus; if (statusCardStrong) statusCardStrong.textContent = playbackStatus;
        const counterSpan = overlay.querySelector('.audioflix-header-actions > span');
        if (counterSpan) {
            const u = state(); counterSpan.textContent = `${(u.soundboard?.length || 0) + portedSounds.length} sounds · ${u.music?.length || 0} tracks · ${u.counters?.routedGeminiEvents || 0} Gemini events`;
        }
        const tokenDesc = overlay.querySelector('.audioflix-status-token-desc');
        if (tokenDesc) tokenDesc.textContent = window.EveAudioflixGemini?.describeSessionUsage?.()
            || 'Gemini token telemetry loads with Search Monitor.';
    }

    window.addEventListener('eve:audioflix-playback', e => {
        playbackStatus = e.detail?.status || playbackStatus;
        const status = String(e.detail?.status || '');
        if (status === 'Ended' && !(e.detail?.remoteManaged && window.EveAudioflixSpotifyQueueHandoff?.isDelegated?.())) completeQueue(e.detail);
        if (queueRuntime.release(e.detail)) rerenderPlayback();
        updateStatusDOM();
        window.EveAudioflixTransport?.sync?.(overlay);
        if (nexusState?.open) rerenderPlayback();
    });
    window.addEventListener('eve:audioflix-progress', e => window.EveAudioflixTransport?.sync?.(overlay, e.detail));
    window.addEventListener('eve:audioflix-state-changed', e => {
        const reasons = e.detail?.reasons || [e.detail?.reason];
        if (reasons.every(reason => reason?.startsWith('audioflix-duration-') || reason?.startsWith('audioflix-soundlab-') || ['audioflix-volume', 'audioflix-play', 'audioflix-exposed', 'audioflix-groups', 'audioflix-active-group', 'audioflix-browser-folders'].includes(reason))) return;
        if (reasons.every(reason => reason === 'audioflix-gemini-audio')) { updateStatusDOM(); return; }
        const scopeReasons = ['audioflix-music-view-mode', 'audioflix-view-mode', 'audioflix-folder-scope', 'audioflix-active-music-group', 'audioflix-active-music-artist', 'audioflix-active-music-classifier'];
        if (reasons.every(reason => scopeReasons.includes(reason)) && lastRenderedRevision === window.EveAudioflixState?.getRevision?.()) return;
        if (!refreshMountedTool()) rerender();
    });
    window.addEventListener('eve:audioflix-gemini-audio-seen', updateStatusDOM);
    window.addEventListener('eve:gemini-usage', updateStatusDOM);
    window.addEventListener('eve:mode2-tokens', updateStatusDOM);
    function probeMissingDurations() {
        const missing = [...(state().music || []), ...(state().soundboard || [])].filter(it => Number(it.duration || 0) <= 0);
        let idx = 0;
        const next = async () => {
            if (idx >= missing.length) return;
            const item = missing[idx++];
            await window.EveAudioflixTransport?.probeItem?.(item, item.type || 'music', { resolveProvider: false }).catch?.(() => 0);
            setTimeout(next, 40);
        };
        if (missing.length) setTimeout(next, 800);
    }

    document.addEventListener('DOMContentLoaded', () => {
        probeMissingDurations();
        startHotkeyFeedbackPoll();
        if (window.__eveAudioflixOpenPending) { window.__eveAudioflixOpenPending = false; open(); }
        else loadPortedSounds();
    });
    ns.queueConnection = { snapshot: () => ({ groupName: activeMusicQueue.groupName, currentIndex: activeMusicQueue.currentIndex, playbackRunId: queueRunId, isPlaying: activeMusicQueue.isPlaying === true, shuffle: activeMusicQueue.shuffle, loop: activeMusicQueue.loop, repeatOne: repeatCurrent, entries: queueRuntime.entries(), actions: [{ id: 'restart', label: 'Restart' }, { id: 'repeat-one', label: repeatCurrent ? 'Loop track on' : 'Loop track', pressed: repeatCurrent }, { id: 'details', label: 'Track details' }] }),
        step: delta => playQueueIndex(activeMusicQueue.currentIndex + delta), jump: index => playQueueIndex(index), syncGroupMembership: (id, group, on) => window.EveAudioflixQueueMembership?.sync?.(uiCtx, id, group, on) || false, move: (from, to) => { const q = activeMusicQueue, source = Number(from), target = Math.max(0, Math.min((q.items?.length || 1) - 1, Number(to))); if (!q.items?.length || !Number.isInteger(source) || !Number.isInteger(target) || source < 0 || source >= q.items.length || source === target) return false; const currentId = q.items[q.currentIndex], items = [...q.items], moved = items.splice(source, 1)[0]; items.splice(target, 0, moved); activeMusicQueue = { ...q, items, currentIndex: Math.max(0, items.indexOf(currentId)) }; playbackStatus = `Queue updated — ${queueTrackAt(target)?.title || 'track'} is #${target + 1}.`; window.EveAudioflixAudio?.syncQueueView?.(); rerenderPlayback(); window.dispatchEvent(new CustomEvent('eve:audioflix-queue-changed')); return true; }, playNext: id => { const q = activeMusicQueue, currentId = q.items?.[q.currentIndex]; if (!q.isPlaying || !currentId || id === currentId) return false; const items = q.items.filter(entry => entry !== id), current = items.indexOf(currentId); if (current < 0) return false; items.splice(current + 1, 0, id); activeMusicQueue = { ...q, items, currentIndex: current }; playbackStatus = `${(state().music || []).find(track => track.id === id)?.title || 'Track'} queued next.`; window.EveAudioflixAudio?.syncQueueView?.(); rerenderPlayback(); window.dispatchEvent(new CustomEvent('eve:audioflix-queue-changed')); return true; }, action: action => ['shuffle-music-group', 'loop-music-group'].includes(action) ? handleAction({ dataset: { afAction: action } }, {}) : action === 'restart' ? restartQueueCurrent() : action === 'repeat-one' ? (window.EveAudioflixSpotifyQueueHandoff?.invalidate?.(), repeatCurrent = !repeatCurrent, window.EveAudioflixAudio?.syncQueueView?.(), repeatCurrent) : action === 'details' ? openQueueDetails() : false };
    ns.queueConnection.adoptManagedSpotify = ({runId, index, itemId, finished}) => { const q = activeMusicQueue; if (runId !== queueRunId || !q.isPlaying || !Number.isInteger(index) || String(q.items?.[index] ?? '') !== itemId) return null; q.currentIndex = index; q.isPlaying = !finished; const track = queueTrackAt(index); window.EveAudioflixAudio?.syncQueueView?.(); rerenderPlayback(); return track; };
    Object.assign(ns, { ready: true, open, openNexus, close, render: rerender, revealCard: uiRender.revealCard, frontendScope: frontendActiveGroup, probeMissingDurations, catalogItems: kind => kind === 'sound' ? [...(state().soundboard || []), ...portedSounds] : [...(state().music || [])] });
    window.EveOSResume?.register?.('audioflix', { open, resume: () => { if (overlay && !document.body.contains(overlay)) overlay = null; refreshMountedTool(); } });
})();
