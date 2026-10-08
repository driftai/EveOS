// --- Modular State Sync Engine: Sync Core ---
window.EveDataStore = window.EveDataStore || {};

(function () {
    const ns = window.EveDataStore._modularSync = window.EveDataStore._modularSync || {};
    if (ns.engineSyncReady) return;
    if (!ns.sharedReady) {
        console.warn('[ModularStateSync] Shared helpers missing; engine sync not initialized.');
        return;
    }

    const { constants, state } = ns;

    function getStateLinks(sourceState) {
        if (Array.isArray(sourceState?.bookmarks?.links)) return sourceState.bookmarks.links;
        if (Array.isArray(sourceState?.links)) return sourceState.links;
        return [];
    }

    function isDefaultWelcomeLink(link) {
        return String(link?.title || '') === 'Welcome'
            && String(link?.url || '') === '#'
            && String(link?.category || '') === 'Start';
    }

    function countRealLinks(candidateLinks) {
        return Array.isArray(candidateLinks)
            ? candidateLinks.filter((link) => link && !isDefaultWelcomeLink(link)).length
            : 0;
    }

    function getLocalLinks() {
        if (typeof window.getLiveLinks === 'function') return window.getLiveLinks();
        if (Array.isArray(window.eveState?.links)) return window.eveState.links;
        if (Array.isArray(window.links)) return window.links;
        return [];
    }

    function getLocalRealLinkCount() {
        const liveCount = countRealLinks(getLocalLinks());
        const loadedCount = Number(window.__eveLastCoreDataLoadSummary?.realLinkCount || 0);
        return Math.max(liveCount, Number.isFinite(loadedCount) ? loadedCount : 0);
    }

    function getAudioflix(sourceState) {
        if (sourceState?.audioflix && typeof sourceState.audioflix === 'object') return sourceState.audioflix;
        const legacy = sourceState?.bookmarks?.config?.audioflix;
        return legacy && typeof legacy === 'object' ? legacy : null;
    }

    function shouldRejectShrinkingRemoteAudioflix(incomingState, options = {}) {
        if (options?.allowDestructiveRemoteApply) return false;
        const incoming = getAudioflix(incomingState);
        if (!incoming) return false;
        const local = window.EveAudioflixState?.ensure?.() || window.eveState?.config?.audioflix;
        const localCount = Array.isArray(local?.music) ? local.music.length : 0;
        const incomingCount = Array.isArray(incoming.music) ? incoming.music.length : 0;
        if (localCount < 25 || incomingCount >= localCount) return false;
        return localCount - incomingCount >= 10 && incomingCount / Math.max(1, localCount) < 0.5;
    }

    function shouldRejectEmptyRemoteState(incomingState, options = {}) {
        if (options?.allowEmptyRemoteApply || options?.allowDestructiveRemoteApply) return false;
        const localRealLinks = getLocalRealLinkCount();
        if (localRealLinks <= 0) return false;
        return countRealLinks(getStateLinks(incomingState)) <= 0;
    }

    function shouldRejectShrinkingRemoteState(incomingState, options = {}) {
        if (options?.allowDestructiveRemoteApply) return false;
        const localRealLinks = getLocalRealLinkCount();
        const incomingRealLinks = countRealLinks(getStateLinks(incomingState));
        if (localRealLinks < 25) return false;
        if (incomingRealLinks >= localRealLinks) return false;
        const missingCount = localRealLinks - incomingRealLinks;
        const shrinkRatio = incomingRealLinks / Math.max(1, localRealLinks);
        return missingCount >= 10 && shrinkRatio < 0.5;
    }

    async function pushLocalState(force = false, knownHash = '', options = {}) {
        const ignoreEnabled = !!options?.ignoreEnabled;
        if (!ns.isHttpContext() || (!ignoreEnabled && !ns.isEnabled())) return false;

        const store = ns.getStore();
        if (!store?.captureState) return false;

        const currentState = store.captureState();
        const stateJson = JSON.stringify(currentState);
        const stateHash = knownHash || ns.hashState(currentState);
        if (!force && (stateHash === state.lastUploadedHash || stateHash === state.lastSyncedLocalHash)) return false;

        const { ok, payload } = await ns.requestJson('/api/eve-state/modular/save', {
            method: 'POST',
            body: stateJson
        });
        if (!ok || !payload?.ok) {
            console.warn('[ModularStateSync] Save failed:', payload?.error || 'Unknown error');
            return false;
        }

        state.lastUploadedHash = stateHash;
        state.lastSyncedLocalHash = stateHash;
        state.remoteSignature = payload?.status?.signature || state.remoteSignature;
        return true;
    }

    async function pullRemoteState(force = false, knownSignature = '', options = {}) {
        const ignoreEnabled = !!options?.ignoreEnabled;
        if (!ns.isHttpContext() || (!ignoreEnabled && !ns.isEnabled())) return false;

        const store = ns.getStore();
        if (!store?.applyState) return false;

        if (!force && knownSignature && state.remoteSignature && knownSignature === state.remoteSignature) {
            return false;
        }

        const { ok, payload } = await ns.requestJson('/api/eve-state/modular/load');
        if (!ok || !payload?.ok) {
            console.warn('[ModularStateSync] Load failed:', payload?.error || 'Unknown error');
            return false;
        }

        const incomingState = payload?.state;
        if (!incomingState || typeof incomingState !== 'object') return false;
        if (shouldRejectEmptyRemoteState(incomingState, options)) {
            state.lastRejectedRemoteAt = Date.now();
            state.rejectedRemoteReason = 'empty-remote';
            state.rejectedRemoteSignature = payload?.status?.signature || knownSignature || '';
            console.warn('[ModularStateSync] Skipped empty remote state over non-empty local state.');
            return false;
        }
        if (shouldRejectShrinkingRemoteState(incomingState, options)) {
            state.lastRejectedRemoteAt = Date.now();
            state.rejectedRemoteReason = 'destructive-shrink';
            state.rejectedRemoteSignature = payload?.status?.signature || knownSignature || '';
            console.warn('[ModularStateSync] Skipped shrinking remote state over larger local state.');
            return false;
        }
        if (shouldRejectShrinkingRemoteAudioflix(incomingState, options)) {
            state.lastRejectedRemoteAt = Date.now();
            state.rejectedRemoteReason = 'destructive-audioflix-shrink';
            state.rejectedRemoteSignature = payload?.status?.signature || knownSignature || '';
            console.warn('[ModularStateSync] Skipped shrinking remote Audioflix state over a larger local library.');
            return false;
        }

        const localHash = ns.captureStateHash();
        const incomingHash = ns.hashState(incomingState);
        if (!force && localHash && incomingHash === localHash) {
            state.remoteSignature = payload?.status?.signature || knownSignature || state.remoteSignature;
            state.lastUploadedHash = localHash;
            state.lastSyncedLocalHash = localHash;
            return false;
        }

        state.applyingRemoteState = true;
        try {
            const applied = !!store.applyState(incomingState);
            if (!applied) return false;

            // Remote state was applied locally — invalidate the hash memo so the
            // post-apply capture reflects the new state instead of a stale cache.
            if (typeof ns.invalidateLocalStateHash === 'function') ns.invalidateLocalStateHash();
            const appliedHash = ns.captureStateHash() || incomingHash;
            ns.refreshUiAfterRemoteApply();
            state.remoteSignature = payload?.status?.signature || knownSignature || state.remoteSignature;
            state.lastUploadedHash = appliedHash;
            state.lastSyncedLocalHash = appliedHash;
            return true;
        } finally {
            state.applyingRemoteState = false;
        }
    }

    async function syncCycle() {
        if (state.syncInFlight || state.applyingRemoteState) return;
        state.syncInFlight = true;
        try {
            const localHash = ns.captureStateHash();
            const localDirty = ns.isLocalDirty(localHash);
            const hasBaseline = !!(state.lastUploadedHash || state.lastSyncedLocalHash);
            const shouldCheckRemote = localDirty || !state.remoteSignature || ns.shouldRunIdleRemoteCheck();
            let remoteStatus = null;

            if (shouldCheckRemote) {
                state.lastRemoteCheckAt = Date.now();
                remoteStatus = await ns.getRemoteStatus();
                if (!hasBaseline && remoteStatus?.signature) {
                    const rejectedAt = state.lastRejectedRemoteAt || 0;
                    const pulled = await pullRemoteState(true, remoteStatus.signature);
                    if (!pulled && state.lastRejectedRemoteAt && state.lastRejectedRemoteAt !== rejectedAt) {
                        await pushLocalState(true, localHash);
                    }
                    return;
                }

                if (remoteStatus?.signature && state.remoteSignature && remoteStatus.signature !== state.remoteSignature) {
                    if (localDirty && ns.getConflictStrategy() === constants.CONFLICT_LOCAL_WINS) {
                        await pushLocalState(true, localHash);
                    } else {
                        const rejectedAt = state.lastRejectedRemoteAt || 0;
                        const pulled = await pullRemoteState(true, remoteStatus.signature);
                        if (!pulled && state.lastRejectedRemoteAt && state.lastRejectedRemoteAt !== rejectedAt) {
                            await pushLocalState(true, localHash);
                        }
                    }
                    return;
                }

                if (remoteStatus?.signature && !state.remoteSignature) {
                    state.remoteSignature = remoteStatus.signature;
                }
            }

            if (!hasBaseline && (!remoteStatus || !remoteStatus.signature) && localHash) {
                await pushLocalState(true, localHash);
                return;
            }

            if (localDirty) {
                await pushLocalState(false, localHash);
            }
        } catch (error) {
            console.warn('[ModularStateSync] Sync cycle failed:', error);
        } finally {
            state.syncInFlight = false;
        }
    }

    async function bootstrap() {
        if (!ns.isHttpContext() || !ns.isEnabled()) return;

        const remoteStatus = await ns.getRemoteStatus();
        if (!remoteStatus) return;
        state.lastRemoteCheckAt = Date.now();

        if ((remoteStatus.fileCount || 0) > 0 && remoteStatus.signature) {
            const localHash = ns.captureStateHash();
            const rejectedAt = state.lastRejectedRemoteAt || 0;
            const pulled = await pullRemoteState(true, remoteStatus.signature);
            if (!pulled && state.lastRejectedRemoteAt && state.lastRejectedRemoteAt !== rejectedAt) {
                await pushLocalState(true, localHash);
            }
        } else {
            await pushLocalState(true);
        }

        state.remoteSignature = remoteStatus.signature || state.remoteSignature;
        const currentHash = ns.captureStateHash();
        if (currentHash) {
            state.lastSyncedLocalHash = currentHash;
            if (!state.lastUploadedHash) state.lastUploadedHash = currentHash;
        }
    }

    Object.assign(ns, {
        pushLocalState,
        pullRemoteState,
        syncCycle,
        bootstrap
    });

    ns.engineSyncReady = true;
})();
