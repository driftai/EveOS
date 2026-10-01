/**
 * Unified State Store Apply Scoped Variants
 */
window.EveDataStore = window.EveDataStore || {};

(function () {
    const ns = window.EveDataStore;
    if (ns.applyScopedVariantsReady) return;
    if (!ns.captureReady || !ns.applySharedReady || !ns.applyScopedHelpersReady) {
        console.warn('[EveDataStore] Scoped apply dependencies missing; scoped variants not initialized.');
        return;
    }

    const getLinks = ns.getLinks;
    const getBookmarkFolders = ns.getBookmarkFolders;
    const cloneConnections = ns.cloneConnections;
    const getConnectionCategoryName = ns.getConnectionCategoryName;
    const parseLibraryKey = ns.parseLibraryKey;
    const findCategoryLibraryData = ns.findCategoryLibraryData;
    const stripLegacyPinnedFlag = ns.stripLegacyPinnedFlag;
    const mergeLibraryEntries = ns.mergeLibraryEntries;
    const deriveLegacyPinsFromLinks = ns.deriveLegacyPinsFromLinks;
    const replaceQuickPinsForWorkspace = ns.replaceQuickPinsForWorkspace;
    const replaceQuickPinsForCard = ns.replaceQuickPinsForCard;
    const replaceQuickPinsForBookmark = ns.replaceQuickPinsForBookmark;
    const replaceQuickPinsForFolder = ns.replaceQuickPinsForFolder;
    const getFolderTreesObject = ns.getFolderTreesObject;
    const buildScopedCategoryKey = ns.buildScopedCategoryKey;
    const filterFolderTreesByWorkspace = ns.filterFolderTreesByWorkspace;
    const getFolderNodes = ns.getFolderNodes;
    const normalizeFolderTreeSettings = ns.normalizeFolderTreeSettings;
    const buildFolderMaps = ns.buildFolderMaps;
    const collectFolderSubtreeIds = ns.collectFolderSubtreeIds;
    const mergeFolderSubtree = ns.mergeFolderSubtree;
    const setLinks = ns.setLinks;
    const setConfig = ns.setConfig;
    const setBookmarkFolders = ns.setBookmarkFolders;
    const setQuickPins = ns.setQuickPins;
    const applyLibraryCategories = ns.applyLibraryCategories;
    const applyConnections = ns.applyConnections;
    const applyKnowledgeState = ns.applyKnowledgeState;

    function applyState(state) {
        if (!state || typeof state !== 'object') return false;
        const hasIncomingPins = !!(state.bookmarks && Object.prototype.hasOwnProperty.call(state.bookmarks, 'pins'));

        if (state.bookmarks) {
            if (Array.isArray(state.bookmarks.links)) {
                setLinks(state.bookmarks.links.map(stripLegacyPinnedFlag));
            }
            if (state.bookmarks.config && typeof state.bookmarks.config === 'object') {
                setConfig(state.bookmarks.config);
            }
            setBookmarkFolders(getFolderTreesObject(state.bookmarks.folders));
            if (hasIncomingPins) {
                setQuickPins(Array.isArray(state.bookmarks.pins) ? state.bookmarks.pins : []);
            } else if (window.EveQuickPins?.migrateLegacyPins) {
                window.EveQuickPins.migrateLegacyPins();
            }
        }

        if (state.library) {
            applyLibraryCategories(state.library.categories);
            if (Array.isArray(state.library.connections)) {
                if (window.EveLibrary?.ConnectionsAPI?.setAll) {
                    window.EveLibrary.ConnectionsAPI.setAll(state.library.connections);
                } else {
                    window.EveLibrary = window.EveLibrary || {};
                    window.EveLibrary.Connections = state.library.connections.map((entry) => ({ ...entry }));
                }
            }
        }

        applyKnowledgeState(state.knowledge);

        // Restore Audioflix (soundboard ports/groups/hotkeys/exposure/volumes). setConfig above
        // doesn't reassign window.eveState.config (the object Audioflix reads), so write it to the
        // canonical location explicitly, then let the module re-normalize, persist, and re-render.
        // Accept the new top-level key OR the legacy nested location from older backups.
        const hasTopLevelAudioflix = Object.prototype.hasOwnProperty.call(state, 'audioflix')
            && state.audioflix && typeof state.audioflix === 'object';
        const legacyConfig = state.bookmarks?.config;
        const hasLegacyAudioflix = !!legacyConfig
            && Object.prototype.hasOwnProperty.call(legacyConfig, 'audioflix')
            && legacyConfig.audioflix && typeof legacyConfig.audioflix === 'object';
        const restoredAudioflix = hasTopLevelAudioflix
            ? state.audioflix
            : (hasLegacyAudioflix ? legacyConfig.audioflix : null);
        const restoredStructure = state.audioflixStructure && typeof state.audioflixStructure === 'object'
            ? state.audioflixStructure : null;
        try {
            // Backups created before Audioflix existed contain neither section. A structural-only
            // backup may restore folders/groups/source connections without carrying song records.
            if (!restoredAudioflix && !restoredStructure) return true;
            if (restoredAudioflix) {
                const stopPromise = window.EveAudioflixAudio?.stopAll?.();
                stopPromise?.catch?.((error) => {
                    console.warn('[DataState] Previous Audioflix playback did not stop cleanly:', error);
                });
                window.EveAudioflixAudioCodec?.clearCache?.();
                if (window.EveAudioflixState?.replaceDatapackState) {
                    window.EveAudioflixState.replaceDatapackState(restoredAudioflix, 'audioflix-restore');
                } else if (window.EveAudioflixState?.replaceState) {
                    window.EveAudioflixState.replaceState(restoredAudioflix || {}, 'audioflix-restore');
                } else {
                    const fallbackAudioflix = restoredAudioflix || {};
                    if (window.eveState && window.eveState.config) window.eveState.config.audioflix = fallbackAudioflix;
                    if (window.config && typeof window.config === 'object') window.config.audioflix = fallbackAudioflix;
                    window.EveAudioflixState?.update?.({}, 'audioflix-restore');
                }
            }
            if (restoredStructure && window.EveAudioflixState?.ensure) {
                window.EveAudioflixStateRecovery?.applyStructureSnapshot?.(
                    window.EveAudioflixState.ensure(), restoredStructure
                );
                window.EveAudioflixState.update?.({}, 'audioflix-restore-structure');
            }
            // Recreate stub records for any backed-up Browser Folder so it appears as
            // "Needs reconnect" (its granted handle can't cross into a fresh browser/incognito).
            window.EveAudioflixFsPorts?.reconcile?.().catch(() => {});
        } catch (error) {
            console.warn('[DataState] Audioflix restore failed:', error);
        }

        return true;
    }

    function applyWorkspaceState(state) {
        if (!state || typeof state !== 'object') return false;
        const workspaceId = state.metadata?.workspaceId || state.bookmarks?.config?.activeWorkspace;
        if (!workspaceId) return false;

        if (Array.isArray(state.bookmarks?.links)) {
            const remaining = getLinks().filter((entry) => entry.workspace !== workspaceId);
            setLinks(remaining.concat(state.bookmarks.links.map((entry) => ({ ...stripLegacyPinnedFlag(entry), workspace: workspaceId }))));
        }

        if (state.bookmarks?.config) {
            const nextConfig = { activeWorkspace: workspaceId };
            // If backup contains a category order for this specific workspace, restore it
            const orderStore = state.bookmarks.config.categoryOrderByWorkspace;
            if (orderStore && typeof orderStore === 'object' && orderStore[workspaceId]) {
                if (window.EveCategoryOrder?.getOrder) {
                    const order = window.EveCategoryOrder.getOrder(workspaceId, { persist: true });
                    // Merge/Replace order
                    const incomingOrder = Array.isArray(orderStore[workspaceId]) ? orderStore[workspaceId] : [];
                    if (incomingOrder.length > 0) {
                        const configStore = window.eveState?.config?.categoryOrderByWorkspace || {};
                        configStore[workspaceId] = incomingOrder;
                        if (window.eveState?.config) window.eveState.config.categoryOrderByWorkspace = configStore;
                    }
                }
            }
            setConfig(nextConfig);
        }
        const existingFolderTrees = getFolderTreesObject(getBookmarkFolders());
        let incomingFolderTrees = filterFolderTreesByWorkspace(state.bookmarks?.folders, workspaceId);
        
        // Fallback: If no trees found for target workspace, but backup has trees, remap them to target workspace
        if (Object.keys(incomingFolderTrees).length === 0) {
            const rawIncoming = getFolderTreesObject(state.bookmarks?.folders);
            Object.entries(rawIncoming).forEach(([key, value]) => {
                const parts = String(key).split('::');
                const cat = parts.length > 1 ? parts.slice(1).join('::') : parts[0];
                incomingFolderTrees[buildScopedCategoryKey(workspaceId, cat)] = value;
            });
        }

        const remainingFolderTrees = Object.fromEntries(
            Object.entries(existingFolderTrees).filter(([key]) => String(key || '').split('::', 1)[0] !== String(workspaceId))
        );
        setBookmarkFolders({ ...remainingFolderTrees, ...incomingFolderTrees });
        if (state.bookmarks && Object.prototype.hasOwnProperty.call(state.bookmarks, 'pins')) {
            replaceQuickPinsForWorkspace(workspaceId, Array.isArray(state.bookmarks?.pins) ? state.bookmarks.pins : []);
        } else if (Array.isArray(state.bookmarks?.links)) {
            replaceQuickPinsForWorkspace(workspaceId, deriveLegacyPinsFromLinks(state.bookmarks.links));
        }

        if (state.library) {
            applyLibraryCategories(state.library.categories);
            applyConnections(workspaceId, state.library.connections || []);
        }

        const workspaceCategoryNames = Array.from(new Set(
            (state.bookmarks?.links || [])
                .map((entry) => String(entry?.category || 'Unsorted').trim() || 'Unsorted')
                .concat(Object.keys(state.library?.categories || {}).map((key) => String(parseLibraryKey(key)?.categoryName || '').trim()).filter(Boolean))
        ));
        applyKnowledgeState(state.knowledge, workspaceCategoryNames);
        if (state.audioflix?.scoped === true) {
            window.EveAudioflixLinks?.mergeScopedBackup?.(state.audioflix, {
                scopeType: 'workspace',
                workspaceId
            });
        }

        return true;
    }

    function applyCardState(state) {
        if (!state || typeof state !== 'object') return false;
        const workspaceId = state.metadata?.workspaceId || state.bookmarks?.config?.activeWorkspace;
        const categoryName = state.metadata?.categoryName;
        if (!workspaceId || !categoryName) return false;

        const targetScopedKey = buildScopedCategoryKey(workspaceId, categoryName);
        const incomingFolders = getFolderTreesObject(state.bookmarks?.folders);
        const folderKeys = Object.keys(incomingFolders);
        
        let incomingTree = incomingFolders[targetScopedKey];
        if (!incomingTree && folderKeys.length === 1) {
            incomingTree = incomingFolders[folderKeys[0]];
        }

        const validFolderIds = new Set(getFolderNodes(incomingTree).map(n => String(n?.id || '').trim()).filter(Boolean));

        if (Array.isArray(state.bookmarks?.links)) {
            const remaining = getLinks().filter((entry) => !(entry.workspace === workspaceId && (entry.category || 'Unsorted') === categoryName));
            const incoming = state.bookmarks.links.map((entry) => {
                const normalized = {
                    ...stripLegacyPinnedFlag(entry),
                    workspace: workspaceId,
                    category: categoryName
                };
                // Clean up folderId if it's not in the tree we are applying
                if (normalized.folderId && !validFolderIds.has(String(normalized.folderId).trim())) {
                    delete normalized.folderId;
                }
                return normalized;
            });
            setLinks(remaining.concat(incoming));
        }

        if (window.EveCategoryOrder?.ensureCategory) {
            window.EveCategoryOrder.ensureCategory(workspaceId, categoryName);
        }

        setConfig({ activeWorkspace: workspaceId });
        if (typeof saveConfig === 'function') saveConfig();

        const existingFolderTrees = getFolderTreesObject(getBookmarkFolders());
        const nextFolderTrees = { ...existingFolderTrees };
        
        if (incomingTree) {
            nextFolderTrees[targetScopedKey] = incomingTree;
        } else {
            delete nextFolderTrees[targetScopedKey];
        }

        setBookmarkFolders(nextFolderTrees);
        if (state.bookmarks && Object.prototype.hasOwnProperty.call(state.bookmarks, 'pins')) {
            replaceQuickPinsForCard(workspaceId, categoryName, Array.isArray(state.bookmarks?.pins) ? state.bookmarks.pins : []);
        } else if (Array.isArray(state.bookmarks?.links)) {
            replaceQuickPinsForCard(workspaceId, categoryName, deriveLegacyPinsFromLinks(state.bookmarks.links));
        }

        if (state.library?.categories && typeof state.library.categories === 'object') {
            const selectedCategory = findCategoryLibraryData(state.library.categories, workspaceId, categoryName);
            if (selectedCategory) {
                // Pass the workspaceId to ensure correct scoping
                applyLibraryCategories({ [categoryName]: selectedCategory }, workspaceId);
            } else {
                applyLibraryCategories(state.library.categories, workspaceId);
            }
        }

        if (Array.isArray(state.library?.connections)) {
            const existing = cloneConnections();
            const incoming = state.library.connections.map((conn) => ({
                ...conn,
                workspace: workspaceId,
                categoryName: categoryName // Force remap connections to the target card
            }));
            const incomingLinkIds = new Set(incoming.map((conn) => conn.linkId).filter(Boolean));
            const filtered = existing.filter((conn) => {
                const connCategory = getConnectionCategoryName(conn) || '';
                // If it's the target workspace and category, we clear it out to make room for incoming
                if (conn.workspace === workspaceId && connCategory === categoryName) return false;
                // If the link ID already exists in incoming, we replace it
                if (incomingLinkIds.has(conn.linkId)) return false;
                return true;
            });
            const next = filtered.concat(incoming);
            if (window.EveLibrary?.ConnectionsAPI?.setAll) {
                window.EveLibrary.ConnectionsAPI.setAll(next);
            } else {
                window.EveLibrary = window.EveLibrary || {};
                window.EveLibrary.Connections = next;
            }
        }

        applyKnowledgeState(state.knowledge, [categoryName]);
        if (state.audioflix?.scoped === true) {
            window.EveAudioflixLinks?.mergeScopedBackup?.(state.audioflix, {
                scopeType: 'card',
                workspaceId,
                categoryName
            });
        }

        return true;
    }

    function applyBookmarkState(state) {
        if (!state || typeof state !== 'object') return false;
        const incomingLinks = Array.isArray(state.bookmarks?.links) ? state.bookmarks.links : [];
        if (!incomingLinks.length) return false;

        const incomingLink = stripLegacyPinnedFlag(incomingLinks[0]);
        const workspaceId = String(
            state.metadata?.workspaceId
            || incomingLink.workspace
            || state.bookmarks?.config?.activeWorkspace
            || ''
        ).trim();
        if (!workspaceId) return false;

        const categoryName = String(
            state.metadata?.categoryName
            || incomingLink.category
            || 'Unsorted'
        ).trim() || 'Unsorted';
        incomingLink.workspace = workspaceId;
        incomingLink.category = categoryName;

        if (!incomingLink.id) return false;
        const normalizedLinkId = String(incomingLink.id);

        const remaining = getLinks().filter((entry) => String(entry.id) !== normalizedLinkId);
        setLinks(remaining.concat(incomingLink));
        setConfig({ activeWorkspace: workspaceId });
        const targetScopedKey = buildScopedCategoryKey(workspaceId, categoryName);
        const incomingFolderTrees = getFolderTreesObject(state.bookmarks?.folders);
        if (Object.prototype.hasOwnProperty.call(incomingFolderTrees, targetScopedKey)) {
            const existingFolderTrees = getFolderTreesObject(getBookmarkFolders());
            setBookmarkFolders({
                ...existingFolderTrees,
                [targetScopedKey]: incomingFolderTrees[targetScopedKey]
            });
        }
        if (state.bookmarks && Object.prototype.hasOwnProperty.call(state.bookmarks, 'pins')) {
            replaceQuickPinsForBookmark(normalizedLinkId, Array.isArray(state.bookmarks?.pins) ? state.bookmarks.pins : []);
        } else if (Array.isArray(state.bookmarks?.links)) {
            replaceQuickPinsForBookmark(normalizedLinkId, deriveLegacyPinsFromLinks(state.bookmarks.links));
        }

        if (state.library?.categories && typeof state.library.categories === 'object') {
            applyLibraryCategories(state.library.categories);
        }

        const existing = cloneConnections();
        const incomingConnections = Array.isArray(state.library?.connections)
            ? state.library.connections.map((conn) => ({
                ...conn,
                linkId: normalizedLinkId,
                workspace: workspaceId,
                categoryName: conn.categoryName || categoryName
            }))
            : [];
        const filtered = existing.filter((conn) => String(conn.linkId) !== normalizedLinkId);
        const next = filtered.concat(incomingConnections);
        if (window.EveLibrary?.ConnectionsAPI?.setAll) {
            window.EveLibrary.ConnectionsAPI.setAll(next);
        } else {
            window.EveLibrary = window.EveLibrary || {};
            window.EveLibrary.Connections = next;
        }

        applyKnowledgeState(state.knowledge, [categoryName]);
        if (state.audioflix?.scoped === true) {
            window.EveAudioflixLinks?.mergeScopedBackup?.(state.audioflix, {
                scopeType: 'bookmark',
                workspaceId,
                categoryName,
                bookmarkId: normalizedLinkId
            });
        }

        return true;
    }

    const applyFolderState = ns.createApplyFolderState({
        getLinks,
        getBookmarkFolders,
        cloneConnections,
        findCategoryLibraryData,
        stripLegacyPinnedFlag,
        mergeLibraryEntries,
        deriveLegacyPinsFromLinks,
        replaceQuickPinsForFolder,
        getFolderTreesObject,
        buildScopedCategoryKey,
        getFolderNodes,
        normalizeFolderTreeSettings,
        buildFolderMaps,
        collectFolderSubtreeIds,
        mergeFolderSubtree,
        setLinks,
        setConfig,
        setBookmarkFolders,
        applyLibraryCategories,
        applyKnowledgeState
    });

    Object.assign(ns, {
        applyState,
        applyWorkspaceState,
        applyCardState,
        applyFolderState,
        applyBookmarkState
    });

    ns.applyScopedVariantsReady = true;
})();
