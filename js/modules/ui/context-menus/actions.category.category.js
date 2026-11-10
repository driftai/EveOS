window.EveContextMenuActions = window.EveContextMenuActions || {};

(function () {
    const ns = window.EveContextMenuActions;
    if (ns.categoryCardActionsReady) return;

    function getCategoryWorkspaceId() {
        return String(window.ctxWsId || config?.activeWorkspace || 'main').trim() || 'main';
    }

    function getDatapackIndexApi() {
        return window.EveOS?.DatapackIndex || window.EveOS?.SearchAdvanced?.Index || null;
    }

    function getLiveLinks() {
        if (typeof window.getLiveLinks === 'function') return window.getLiveLinks();
        if (Array.isArray(window.eveState?.links)) return window.eveState.links;
        if (Array.isArray(window.links)) return window.links;
        if (typeof links !== 'undefined' && Array.isArray(links)) return links;
        return [];
    }

    function setLiveLinks(nextLinks) {
        if (typeof window.setLiveLinks === 'function') return window.setLiveLinks(nextLinks);
        if (window.eveState) window.eveState.links = nextLinks;
        window.links = nextLinks;
        if (typeof links !== 'undefined') links = nextLinks;
        return nextLinks;
    }

    function getExactCategoryLinkIds(workspaceId, categoryName) {
        const indexApi = getDatapackIndexApi();
        if (!indexApi || typeof indexApi.getExactBookmarkLinkIds !== 'function') return null;
        const hasReadableSnapshot = typeof indexApi.hasReadableLinkSnapshot === 'function'
            ? indexApi.hasReadableLinkSnapshot()
            : (typeof indexApi.hasUsableSnapshot === 'function'
                ? indexApi.hasUsableSnapshot()
                : !!indexApi.getSnapshot?.());
        if (!hasReadableSnapshot) return null;
        return indexApi.getExactBookmarkLinkIds({
            workspaceId: workspaceId,
            categoryName: categoryName
        }) || [];
    }

    function getScopedCategoryLinkIds(workspaceId, categoryName) {
        const scopedIds = new Set();
        getLiveScopedCategoryLinks(workspaceId, categoryName).forEach(function (link) {
            const linkId = String(link?.id || '').trim();
            if (linkId) scopedIds.add(linkId);
        });
        (getExactCategoryLinkIds(workspaceId, categoryName) || []).forEach(function (linkId) {
            const normalizedId = String(linkId || '').trim();
            if (normalizedId) scopedIds.add(normalizedId);
        });
        return Array.from(scopedIds);
    }

    function getScopedCategoryLinks(workspaceId, categoryName) {
        const indexApi = getDatapackIndexApi();
        const exactIds = getExactCategoryLinkIds(workspaceId, categoryName);
        if (exactIds && indexApi && typeof indexApi.resolveBookmarkLink === 'function') {
            const resolvedById = new Map();
            exactIds.forEach(function (linkId) {
                const normalizedId = String(linkId || '').trim();
                if (!normalizedId) return;
                const resolved = indexApi.resolveBookmarkLink(normalizedId);
                if (resolved) resolvedById.set(normalizedId, resolved);
            });
            getLiveScopedCategoryLinks(workspaceId, categoryName).forEach(function (link) {
                const normalizedId = String(link?.id || '').trim();
                if (!normalizedId || resolvedById.has(normalizedId)) return;
                resolvedById.set(normalizedId, link);
            });
            return Array.from(resolvedById.values());
        }

        const folderScopeShared = window.EveFolderViewV2?._shared || null;
        if (folderScopeShared && typeof folderScopeShared.getCategoryLinks === 'function') {
            return folderScopeShared.getCategoryLinks(workspaceId, categoryName);
        }
        const sourceLinks = typeof getModalLinks === 'function' ? getModalLinks() : getLiveLinks();
        return sourceLinks.filter(function (link) {
            return String(link?.workspace || '') === String(workspaceId || '')
                && String(link?.category || 'Unsorted') === String(categoryName || 'Unsorted');
        });
    }

    function getLiveScopedCategoryLinks(workspaceId, categoryName) {
        const sourceLinks = getLiveLinks();
        return sourceLinks.filter(function (link) {
            return String(link?.workspace || 'main').trim() === String(workspaceId || 'main').trim()
                && String(link?.category || 'Unsorted').trim() === String(categoryName || 'Unsorted').trim();
        });
    }

    window.deleteCategory = async function (name) {
        try {
            const workspaceId = String(window.config?.activeWorkspace || window.ctxWsId || 'main').trim() || 'main';
            if (window.EveDetachedDashboardCard?.isDetachedParkingCategory?.(name, workspaceId)) {
                if (typeof showToast === 'function') {
                    showToast('Detached parking is managed from the map and cannot be deleted as a normal card.', 'info');
                }
                if (typeof closeAllMenus === 'function') closeAllMenus();
                if (typeof closeModals === 'function') closeModals();
                return;
            }

            if (!(await showConfirm('Delete Category?'))) return;

            const removedIds = getScopedCategoryLinkIds(workspaceId, name);
            const nextLinks = getLiveLinks()
                .filter((entry) => !(
                    String(entry?.workspace || 'main').trim() === workspaceId
                    && String(entry?.category || 'Unsorted').trim() === String(name || 'Unsorted').trim()
                ));
            setLiveLinks(nextLinks);

            if (window.EveBookmarkFolders?.deleteCategoryScope) {
                window.EveBookmarkFolders.deleteCategoryScope(workspaceId, name);
            } else if (window.EveBookmarkFolders?.deleteCategoryEverywhere) {
                window.EveBookmarkFolders.deleteCategoryEverywhere(name);
            }
            if (window.EveLibrary?.ConnectionsAPI?.removeByLinkIds) {
                window.EveLibrary.ConnectionsAPI.removeByLinkIds(removedIds, { immediate: true });
            } else if (window.EveLibrary?.ConnectionsAPI?.removeByLinkId) {
                removedIds.forEach((id) => window.EveLibrary.ConnectionsAPI.removeByLinkId(id));
            }
            if (window.EveCategoryOrder?.removeCategory) {
                window.EveCategoryOrder.removeCategory(workspaceId, name);
            } else if (window.EveCategoryOrder?.removeCategoryEverywhere) {
                window.EveCategoryOrder.removeCategoryEverywhere(name);
            } else if (window.config?.categoryOrder) {
                window.config.categoryOrder = window.config.categoryOrder.filter((category) => category !== name);
            }
            if (typeof saveConfig === 'function') {
                saveConfig({
                    source: 'category-delete-config',
                    meta: { workspaceId: workspaceId, categoryName: name }
                });
            }
            if (typeof saveData === 'function') {
                saveData({
                    skipRender: true,
                    source: 'category-delete-links',
                    meta: { workspaceId: workspaceId, categoryName: name, removedCount: removedIds.length }
                });
            }
            if (typeof closeAllMenus === 'function') closeAllMenus();
            if (typeof closeModals === 'function') closeModals();
            if (typeof renderDashboard === 'function') renderDashboard();
            if (typeof renderSidebar === 'function') renderSidebar();
        } catch (error) {
            console.error('Error in deleteCategory:', error);
            if (typeof showToast === 'function') {
                showToast(`Failed to delete category: ${error.message}`, 'error');
            } else {
                console.error('Failed to delete category:', error);
            }
        }
    };

    window.ctxCatToggleTask = function () {
        const categoryName = ns.getCtxCategoryName?.();
        if (!categoryName) return showToast('No category selected', 'error');
        const workspaceId = getCategoryWorkspaceId();
        const folderApi = window.EveBookmarkFolders;

        if (folderApi?.setCardTaskEnabled && folderApi?.isCardTaskEnabled) {
            const nextEnabled = !folderApi.isCardTaskEnabled(workspaceId, categoryName);
            folderApi.setCardTaskEnabled(workspaceId, categoryName, nextEnabled);
            showToast(nextEnabled ? 'Task mode enabled' : 'Task mode disabled', 'info');
        } else {
            if (config.hideStats.includes(categoryName)) config.hideStats = config.hideStats.filter((entry) => entry !== categoryName);
            else config.hideStats.push(categoryName);
        }

        saveConfig();
        renderDashboard();
    };

    window.ctxCatToggleSmartBadge = function () {
        const categoryName = ns.getCtxCategoryName?.();
        if (!categoryName) return showToast('No category selected', 'error');

        const wsId = getCategoryWorkspaceId();
        const scopedKey = wsId + '::' + categoryName;

        if (!Array.isArray(config.smartCardWeights)) config.smartCardWeights = [];

        if (config.smartCardWeights.includes(scopedKey)) {
            config.smartCardWeights = config.smartCardWeights.filter((entry) => entry !== scopedKey);
            showToast('Smart Average Badge Disabled', 'info');
        } else {
            config.smartCardWeights.push(scopedKey);
            showToast('Smart Average Badge Enabled', 'info');
        }

        saveConfig();
        if (typeof renderDashboard === 'function') renderDashboard();
    };

    window.ctxCatToggleCustomOrder = function () {
        const categoryName = ns.getCtxCategoryName?.();
        if (!categoryName) return showToast('No category selected', 'error');
        const api = window.EveCustomOrder;
        if (!api) return showToast('Custom order module not loaded', 'error');
        const wsId = getCategoryWorkspaceId();
        var cardLinks = getScopedCategoryLinks(wsId, categoryName);
        api.toggle(wsId, categoryName, cardLinks);
        if (typeof closeAllMenus === 'function') closeAllMenus();
        showToast(api.isEnabled(wsId, categoryName) ? 'Custom numbering enabled' : 'Custom numbering disabled', 'info');
    };

    window.ctxCatCycleSortOrder = function () {
        const categoryName = ns.getCtxCategoryName?.();
        if (!categoryName) return showToast('No category selected', 'error');
        const api = window.EveCustomOrder;
        if (!api) return;
        const wsId = getCategoryWorkspaceId();
        api.cycleSortMode(wsId, categoryName);
        if (typeof closeAllMenus === 'function') closeAllMenus();
        var mode = api.getSortMode(wsId, categoryName);
        var labels = { none: 'Sort: None (positional)', asc: 'Sort: Ascending', desc: 'Sort: Descending' };
        showToast(labels[mode] || mode, 'info');
    };

    window.ctxCatToggleTrueValue = function () {
        const categoryName = ns.getCtxCategoryName?.();
        if (!categoryName) return showToast('No category selected', 'error');
        const api = window.EveTrueValue;
        if (!api) return;
        const wsId = getCategoryWorkspaceId();
        api.toggle(wsId, categoryName);
        if (typeof closeAllMenus === 'function') closeAllMenus();
        var enabled = api.isEnabled(wsId, categoryName);
        showToast(enabled ? 'True Value Sort enabled' : 'True Value Sort disabled', 'info');
    };

    window.ctxCatFocus = function () {
        const categoryName = ns.getCtxCategoryName?.();
        if (!categoryName) return showToast('No category selected', 'error');
        setFocus(categoryName);
    };

    window.ctxCatRename = function () {
        const categoryName = ns.getCtxCategoryName?.();
        if (!categoryName) return showToast('No category selected', 'error');
        openRenameModal(categoryName);
    };

    window.ctxCatLaunch = function () {
        const categoryName = ns.getCtxCategoryName?.();
        if (!categoryName) return showToast('No category selected', 'error');
        launchCategory(categoryName, getCategoryWorkspaceId());
    };

    ns.categoryCardActionsReady = true;
})();
