window.DashboardCategories = window.DashboardCategories || {};

(function () {
    var api = window.DashboardCategories._builderCard = window.DashboardCategories._builderCard || {};
    if (api.cardRenderFullReady) return;

    var {
        escapeCardHtml,
        escapeCardJs,
        buildScopedCategoryKey,
        getCardHeaderButtonsForCategory,
        isCardBookmarkProgressiveRevealEnabled,
        isFolderBookmarkProgressiveRevealEnabled,
        buildFolderSectionsHtml,
        getCardDatapackSummary
    } = api;

function renderCardFull(catInput, catLinks, gridContainer, configOptions) {
        var options = configOptions || {};
        var cat = typeof catInput === 'object' && catInput ? catInput.category : catInput;
        var cardWorkspaceId = typeof catInput === 'object' && catInput
            ? (catInput.workspaceId || options.activeWorkspace || 'main')
            : (options.activeWorkspace || 'main');
        var isDetachedParkingCard = !!options.detachedParkingCard;
        var isFocusMode = !!options.focusMode;
        var isSubTabInParentView = !!options.isSubTabInParentView;
        if (!isSubTabInParentView && options._parentDashboardWorkspace) {
            var parentDashboardWorkspaceId = String(options._parentDashboardWorkspace || '').trim();
            isSubTabInParentView = !!parentDashboardWorkspaceId
                && parentDashboardWorkspaceId !== String(cardWorkspaceId || '').trim();
        }
        options.isSubTabInParentView = isSubTabInParentView;
        var focusedFilterMode = (isFocusMode && typeof window.DashboardCategories.getFocusedEntriesFilterMode === 'function')
            ? window.DashboardCategories.getFocusedEntriesFilterMode()
            : 'all';
        var focusedSortBy = (isFocusMode && typeof window.DashboardCategories.getFocusedEntriesSortBy === 'function')
            ? window.DashboardCategories.getFocusedEntriesSortBy()
            : 'none';
        var focusedSortOrder = (isFocusMode && typeof window.DashboardCategories.getFocusedEntriesSortOrder === 'function')
            ? window.DashboardCategories.getFocusedEntriesSortOrder()
            : 'desc';

        var visibleLinks = (isFocusMode && typeof window.DashboardCategories.matchesFocusedEntriesFilter === 'function')
            ? catLinks.filter(function (link) {
                return window.DashboardCategories.matchesFocusedEntriesFilter(link, focusedFilterMode);
            })
            : (catLinks.length > 500 && !isFocusMode ? catLinks : catLinks.slice());
        var renderedLinks = (isFocusMode && typeof window.DashboardCategories.sortFocusedLinks === 'function')
            ? window.DashboardCategories.sortFocusedLinks(visibleLinks)
            : (catLinks.length > 500 && !isFocusMode ? visibleLinks : visibleLinks.slice());

        var card = document.createElement('div');
        card.className = 'category-card';
        if (!isFocusMode && Array.isArray(options.collapsed) && options.collapsed.includes(cat)) {
            card.classList.add('collapsed');
        }
        if (!isFocusMode && Array.isArray(options.foldersCollapsed) && options.foldersCollapsed.includes(cat)) {
            card.classList.add('folders-collapsed');
        }
        if (!isFocusMode && Array.isArray(options.linksCollapsed) && options.linksCollapsed.includes(cat)) {
            card.classList.add('links-collapsed');
        }

        var folderTaskApi = window.EveBookmarkFolders;
        var safeCatHtml = escapeCardHtml(cat || 'Unsorted');
        var safeCatJs = escapeCardJs(cat || 'Unsorted');
        var libraryPanelId = 'lib-' + String(cat || 'Unsorted').replace(/[^a-zA-Z0-9]/g, '_') + '-panel';
        var folderToolbarExpanded = !!folderTaskApi?.isToolbarExpanded?.(cardWorkspaceId, cat);
        var folderHeaderBtnClass = 'category-action-btn' + (folderToolbarExpanded ? ' is-active' : '');

        function isTaskEnabledForLink(link) {
            if (typeof folderTaskApi?.isTaskEnabledForLink === 'function') {
                return !!folderTaskApi.isTaskEnabledForLink(link);
            }
            if (typeof folderTaskApi?.isCardTaskEnabled === 'function') {
                return !!folderTaskApi.isCardTaskEnabled(link?.workspace || summaryWorkspaceId, link?.category || cat);
            }
            return !Array.isArray(options.hideStats) || !options.hideStats.includes(cat);
        }

        var totalAll = catLinks.length;
        var totalVisible = renderedLinks.length;
        var isMegaCard = catLinks.length > 500;
        var summaryWorkspaceId = String(cardWorkspaceId || options.activeWorkspace || config.activeWorkspace || 'main').trim() || 'main';
        var datapackSummary = getCardDatapackSummary(summaryWorkspaceId, cat);

        var totalAllTasks = 0;
        var doneAll = 0;
        var totalVisibleTasks = 0;
        var doneVisible = 0;

        if (!isMegaCard) {
            for (var allIndex = 0; allIndex < catLinks.length; allIndex++) {
                if (isTaskEnabledForLink(catLinks[allIndex])) {
                    totalAllTasks++;
                    if (catLinks[allIndex].done) doneAll++;
                }
            }
            for (var visibleIndex = 0; visibleIndex < renderedLinks.length; visibleIndex++) {
                if (isTaskEnabledForLink(renderedLinks[visibleIndex])) {
                    totalVisibleTasks++;
                    if (renderedLinks[visibleIndex].done) doneVisible++;
                }
            }
        }

        var hasTaskBookmarks = totalAllTasks > 0;
        if (hasTaskBookmarks) {
            card.classList.add('task-mode');
        }
        var isTaskMode = hasTaskBookmarks;
        var customOrderApi = window.EveCustomOrder;
        var activeWorkspaceId = String(cardWorkspaceId || options.activeWorkspace || config.activeWorkspace || 'main');
        var progressiveBookmarkRevealEnabled = typeof isCardBookmarkProgressiveRevealEnabled === 'function'
            ? isCardBookmarkProgressiveRevealEnabled(activeWorkspaceId, cat)
            : true;
        var progressiveBookmarkRenderCap = window._eveMegaPerfMode ? 12 : (window._evePerfMode ? 20 : 50);
        var cardProgressiveRenderBudget = (!isFocusMode && (isMegaCard || window._eveMegaPerfMode))
            ? (window._eveMegaPerfMode ? 80 : 120)
            : Number.MAX_SAFE_INTEGER;
        var cardProgressiveRendered = 0;
        var customOrderEnabled = !isMegaCard && customOrderApi ? customOrderApi.isEnabled(activeWorkspaceId, cat) : false;
        if (customOrderEnabled) {
            card.classList.add('custom-order');
            customOrderApi.ensureAllLinksHaveNumbers(activeWorkspaceId, cat, renderedLinks);
        }

        if (!isMegaCard) {
            renderedLinks.forEach(function (link, index) {
                var linkId = String(link.id);
                if (customOrderEnabled && customOrderApi) {
                    var customOrderNumber = customOrderApi.getNumber(activeWorkspaceId, cat, linkId);
                    link._basePos = (typeof customOrderNumber === 'number') ? customOrderNumber : (index + 1);
                } else {
                    link._basePos = index + 1;
                }
            });

            if (customOrderApi) {
                renderedLinks = customOrderApi.applySorting(renderedLinks, activeWorkspaceId, cat);
            }
        }

        var trueValueApi = window.EveTrueValue;
        var trueValueEnabled = !isMegaCard && trueValueApi ? trueValueApi.isEnabled(activeWorkspaceId, cat) : false;
        var trueValueData = null;
        var currentSortMode = customOrderApi ? customOrderApi.getSortMode(activeWorkspaceId, cat) : 'none';
        if (trueValueEnabled) {
            card.classList.add('true-value-mode');
            trueValueData = trueValueApi.computeTrueValues(renderedLinks, activeWorkspaceId, cat);
            renderedLinks = trueValueApi.applySorting(renderedLinks, trueValueData, currentSortMode);
        }

        var smartWeightBadgeHtml = '';
        var smartCardWeights = window.eveState?.config?.smartCardWeights;
        var isSmartBadgeEnabled = Array.isArray(smartCardWeights) && smartCardWeights.includes(activeWorkspaceId + '::' + cat);
        if (isSmartBadgeEnabled && trueValueApi && !isMegaCard) {
            var trueValueMath = trueValueData || trueValueApi.computeTrueValues(renderedLinks, activeWorkspaceId, cat, { forceEnabled: true });
            var ratingSum = 0;
            var ratingCount = 0;
            Object.keys(trueValueMath).forEach(function (key) {
                var rating = trueValueMath[key].rating;
                if (typeof rating === 'number') {
                    ratingSum += rating;
                    ratingCount++;
                }
            });
            if (ratingCount >= 1) {
                var average = ratingSum / ratingCount;
                smartWeightBadgeHtml = '<div class="card-smart-weight-badge" title="Average smart rating based on ' + ratingCount + ' weighted bookmarks.">[ \u2728 ' + average.toFixed(1) + ' ]</div>';
            }
        }

        if (isFocusMode) {
            card.classList.add('is-focus-mode');
        }
        var pct = totalAllTasks === 0 ? 0 : (doneAll / totalAllTasks) * 100;
        var barClass = pct === 100 && totalAllTasks > 0 ? 'complete' : '';

        card.ondragover = function (event) {
            if (typeof allowDrop === 'function') allowDrop(event);
            if (typeof window.isCategoryCardDragPayload === 'function' && window.isCategoryCardDragPayload(event)) {
                card.classList.add('card-drop-target');
            }
        };
        card.ondragenter = function (event) {
            if (typeof window.isCategoryCardDragPayload === 'function' && window.isCategoryCardDragPayload(event)) {
                event.preventDefault();
                card.classList.add('card-drop-target');
            }
        };
        card.ondragleave = function (event) {
            if (!event.relatedTarget || !card.contains(event.relatedTarget)) {
                card.classList.remove('card-drop-target');
            }
        };
        card.ondrop = function (event) {
            card.classList.remove('card-drop-target');
            if (typeof window.dropCategoryCardOnCard === 'function' && window.dropCategoryCardOnCard(event, activeWorkspaceId, cat)) {
                return;
            }
            if (isDetachedParkingCard) {
                if (window.EveConstellationMap && window.EveConstellationMap._detached && typeof window.EveConstellationMap._detached.handleDashboardParkingDrop === 'function') {
                    window.EveConstellationMap._detached.handleDashboardParkingDrop(event, activeWorkspaceId);
                }
                return;
            }
            if (typeof drop === 'function') drop(event, cat);
        };

        var renderLinkCollection = api.createCardLinkCollectionRenderer({
            cat: cat,
            safeCatHtml: safeCatHtml,
            activeWorkspaceId: activeWorkspaceId,
            cardWorkspaceId: cardWorkspaceId,
            options: options,
            isFocusMode: isFocusMode,
            customOrderEnabled: customOrderEnabled,
            customOrderApi: customOrderApi,
            trueValueEnabled: trueValueEnabled,
            trueValueApi: trueValueApi,
            trueValueData: trueValueData,
            currentSortMode: currentSortMode,
            progressiveBookmarkRevealEnabled: progressiveBookmarkRevealEnabled,
            progressiveBookmarkRenderCap: progressiveBookmarkRenderCap,
            cardProgressiveRenderBudget: cardProgressiveRenderBudget,
            isFolderBookmarkProgressiveRevealEnabled: isFolderBookmarkProgressiveRevealEnabled,
            isTaskEnabledForLink: isTaskEnabledForLink
        });

        var shouldSkipGhosts = (options._skipGhosts !== undefined) ? !!options._skipGhosts : isMegaCard;
        var folderOptions = shouldSkipGhosts
            ? Object.assign({}, options, { skipGhosts: true, activeWorkspace: activeWorkspaceId })
            : Object.assign({}, options, { activeWorkspace: activeWorkspaceId });
        var listHtml = buildFolderSectionsHtml(cat, renderedLinks, folderOptions, renderLinkCollection);

        var shownSuffix = (isFocusMode && focusedFilterMode !== 'all') ? ' shown' : '';
        var titleMetaText = isTaskMode
            ? (totalVisible + ' bookmarks' + shownSuffix + ' &bull; ' + doneVisible + ' done' + ' &bull; ' + Math.max(totalVisibleTasks - doneVisible, 0) + ' to-do')
            : (totalVisible + ' bookmarks' + shownSuffix);
        if (datapackSummary) {
            var datapackBits = [];
            var sourceCount = Number(datapackSummary.knowledgeCount || 0) + Number(datapackSummary.cachedCount || 0);
            if (Number(datapackSummary.libraryCount || 0) > 0) {
                datapackBits.push(String(Number(datapackSummary.libraryCount || 0)) + ' library');
            }
            if (sourceCount > 0) {
                datapackBits.push(String(sourceCount) + ' source');
            }
            if (Number(datapackSummary.hiddenCount || 0) > 0) {
                datapackBits.push(String(Number(datapackSummary.hiddenCount || 0)) + ' hidden');
            }
            var issueCount = Number(datapackSummary.localIssueCount || 0);
            if (issueCount > 0) {
                datapackBits.push(String(issueCount) + ' issues');
            }
            if (datapackBits.length) {
                titleMetaText += ' &bull; ' + datapackBits.join(' &bull; ');
            }
        }
        var titleMetaHtml = '<div class="' + (isFocusMode ? 'cat-focus-meta' : 'cat-card-meta') + '">' + titleMetaText + '</div>';

        activeWorkspaceId = String(cardWorkspaceId || window.eveState?.config?.activeWorkspace || 'main').trim() || 'main';
        var cardOrderIndex = -1;
        if (window.EveCategoryOrder && window.EveCategoryOrder.getOrder) {
            cardOrderIndex = window.EveCategoryOrder.getOrder(activeWorkspaceId).indexOf(cat);
        }
        var cardOrderDisplay = cardOrderIndex >= 0 ? (cardOrderIndex + 1) : '-';
        var cardOrderHtml = (!isFocusMode)
            ? '<div class="card-order-number" onclick="if(window.promptMoveCategory) window.promptMoveCategory(\'' + safeCatJs + '\', ' + cardOrderIndex + ', \'' + escapeCardJs(activeWorkspaceId) + '\', this)" title="Move card to a specific position">#' + cardOrderDisplay + '</div>'
            : '';

        var titleControlsHtml = isFocusMode
            ? ''
            : ''
            + '<span class="collapse-arrow" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" data-cat="' + safeCatHtml + '" onclick="toggleLinksCollapse(this.dataset.cat, this.dataset.ws)" title="Toggle Bookmarks">&#128216;</span>'
            + '<span class="collapse-arrow" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" data-cat="' + safeCatHtml + '" onclick="toggleFolderCollapse(this.dataset.cat, this.dataset.ws)" title="Toggle Folders">&#128193;</span>'
            + '<span class="collapse-arrow" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" data-cat="' + safeCatHtml + '" onclick="toggleCollapse(this.dataset.cat, this.dataset.ws)" title="Toggle Card">&#9660;</span>'
            + '<span class="sort-btn" onclick="moveCategory(\'' + safeCatJs + '\', -1, \'' + escapeCardJs(activeWorkspaceId) + '\')">&#9650;</span>'
            + '<span class="sort-btn" onclick="moveCategory(\'' + safeCatJs + '\', 1, \'' + escapeCardJs(activeWorkspaceId) + '\')">&#9660;</span>'
            + cardOrderHtml;
        var cardTargetId = window.EveQuickPins?.buildCardTargetId
            ? window.EveQuickPins.buildCardTargetId(activeWorkspaceId, cat)
            : buildScopedCategoryKey(activeWorkspaceId, cat);
        var detachedMapButtonHtml = isDetachedParkingCard
            ? '<button class="card-header-icon-btn constellation-btn" onclick="if(window.EveDetachedDashboardCard) window.EveDetachedDashboardCard.openDetachedParkingMap(\'' + escapeCardJs(activeWorkspaceId) + '\')" title="Detached Map">&#127756;</button>'
            : '';
        var detachedFocusMapButtonHtml = isDetachedParkingCard
            ? '<button class="category-action-btn" onclick="if(window.EveDetachedDashboardCard) window.EveDetachedDashboardCard.openDetachedParkingMap(\'' + escapeCardJs(activeWorkspaceId) + '\')" title="Detached Map">&#127756; <span>Map</span></button>'
            : '';
        var visibleHeaderButtons = new Set(getCardHeaderButtonsForCategory(activeWorkspaceId, cat));
        var nonFocusButtons = [];
        if (!isDetachedParkingCard && visibleHeaderButtons.has('add')) {
            nonFocusButtons.push('<button class="card-header-icon-btn" data-cat="' + safeCatHtml + '" onclick="openAddModal(this.dataset.cat)" title="Add Bookmark">&#10133;</button>');
        }
        if (!isDetachedParkingCard && visibleHeaderButtons.has('folders')) {
            nonFocusButtons.push('<button class="' + (folderToolbarExpanded ? 'card-header-icon-btn card-folder-toggle-btn is-active' : 'card-header-icon-btn card-folder-toggle-btn') + '" data-folder-toolbar-toggle="1" data-cat="' + safeCatHtml + '" data-ws="' + escapeCardHtml(options.activeWorkspace || 'main') + '" onclick="toggleBookmarkFolderToolbar(this.dataset.cat, this.dataset.ws)" title="Folders">&#128193;</button>');
        }
        if (!isDetachedParkingCard && visibleHeaderButtons.has('library')) {
            nonFocusButtons.push('<button class="card-header-icon-btn lib-toggle-btn" data-cat="' + safeCatHtml + '" onclick="toggleCategoryLibrary(this.dataset.cat)" title="Library">&#128218;</button>');
        }
        if (visibleHeaderButtons.has('focus')) {
            nonFocusButtons.push('<button class="card-header-icon-btn" data-cat="' + safeCatHtml + '" onclick="setFocus(this.dataset.cat)" title="Focus">&#127919;</button>');
        }
        if (isDetachedParkingCard) {
            nonFocusButtons.push(detachedMapButtonHtml);
        }
        if (!isDetachedParkingCard && visibleHeaderButtons.has('constellation')) {
            nonFocusButtons.push('<button class="card-header-icon-btn constellation-btn" data-cat="' + safeCatHtml + '" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" onclick="if(window.EveConstellationMap) window.EveConstellationMap.openCardMap(this.dataset.ws, this.dataset.cat)" title="Constellation Map">&#127756;</button>');
        }
        if (!isDetachedParkingCard) {
            nonFocusButtons.push('<button class="card-header-icon-btn" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" data-cat="' + safeCatHtml + '" onclick="openCategorySettings(this.dataset.cat, undefined, this.dataset.ws)" title="Settings">&#9881;</button>');
        }
        if (!isDetachedParkingCard && visibleHeaderButtons.has('launch')) {
            nonFocusButtons.push('<button class="card-header-icon-btn launch-btn" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" data-cat="' + safeCatHtml + '" onclick="launchCategory(this.dataset.cat, this.dataset.ws)" title="Launch">&#128640;</button>');
        }

        var headerButtonsHtml = isFocusMode
            ? ''
            + '<div class="focus-card-controls">'
            + '<button class="category-action-btn bulk-scope-btn" data-scope-category="' + safeCatHtml + '" data-scope-workspace="' + escapeCardHtml(activeWorkspaceId) + '" onclick="bulkToggleCardScopeSelection(this.dataset.scopeCategory, this.dataset.scopeWorkspace)" title="Select all bookmarks in this card">&#9744; <span>Select Card</span></button>'
            + (!isDetachedParkingCard && visibleHeaderButtons.has('add')
                ? '<button class="category-action-btn" data-cat="' + safeCatHtml + '" onclick="openAddModal(this.dataset.cat)" title="Add Bookmark">&#10133; <span>Add</span></button>'
                : '')
            + (!isDetachedParkingCard && visibleHeaderButtons.has('folders')
                ? '<button class="' + folderHeaderBtnClass + '" data-folder-toolbar-toggle="1" data-cat="' + safeCatHtml + '" data-ws="' + escapeCardHtml(options.activeWorkspace || 'main') + '" onclick="toggleBookmarkFolderToolbar(this.dataset.cat, this.dataset.ws)" title="Folders">&#128193; <span>Folders</span></button>'
                : '')
            + (!isDetachedParkingCard && visibleHeaderButtons.has('library')
                ? '<button class="category-action-btn" data-cat="' + safeCatHtml + '" onclick="toggleCategoryLibrary(this.dataset.cat)" title="Library">&#128218; <span>Library</span></button>'
                : '')
            + (!isDetachedParkingCard && visibleHeaderButtons.has('constellation')
                ? '<button class="category-action-btn" data-cat="' + safeCatHtml + '" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" onclick="if(window.EveConstellationMap) window.EveConstellationMap.openCardMap(this.dataset.ws, this.dataset.cat)" title="Constellation Map">&#127756; <span>Map</span></button>'
                : '')
            + detachedFocusMapButtonHtml
            + '<select class="unidex-filter-select focus-filter-select" aria-label="Focused bookmark filter" onchange="window.DashboardCategories.setFocusedEntriesFilterMode(this.value)">'
            + '<option value="all"' + (focusedFilterMode === 'all' ? ' selected' : '') + '>All Bookmarks</option>'
            + '<option value="linked"' + (focusedFilterMode === 'linked' ? ' selected' : '') + '>Library Linked</option>'
            + '<option value="bookmark-only"' + (focusedFilterMode === 'bookmark-only' ? ' selected' : '') + '>Bookmarks Only</option>'
            + '</select>'
            + '<select class="unidex-filter-select focus-sort-select" aria-label="Focused linked rating sort" onchange="window.DashboardCategories.setFocusedEntriesSortBy(this.value)">'
            + '<option value="none"' + (focusedSortBy === 'none' ? ' selected' : '') + '>Sort Off</option>'
            + '<option value="active"' + (focusedSortBy === 'active' ? ' selected' : '') + '>Active</option>'
            + '<option value="unified"' + (focusedSortBy === 'unified' ? ' selected' : '') + '>Unified</option>'
            + '<option value="personal"' + (focusedSortBy === 'personal' ? ' selected' : '') + '>Personal</option>'
            + '<option value="api_weighted"' + (focusedSortBy === 'api_weighted' ? ' selected' : '') + '>API Weighted</option>'
            + '<option value="api_average"' + (focusedSortBy === 'api_average' ? ' selected' : '') + '>API Average</option>'
            + '<option value="confidence"' + (focusedSortBy === 'confidence' ? ' selected' : '') + '>Confidence</option>'
            + '<option value="truevalue"' + (focusedSortBy === 'truevalue' ? ' selected' : '') + '>True Value</option>'
            + '</select>'
            + '<select class="unidex-filter-select focus-sort-order-select" aria-label="Focused linked rating sort order" onchange="window.DashboardCategories.setFocusedEntriesSortOrder(this.value)">'
            + '<option value="desc"' + (focusedSortOrder === 'desc' ? ' selected' : '') + '>Desc</option>'
            + '<option value="asc"' + (focusedSortOrder === 'asc' ? ' selected' : '') + '>Asc</option>'
            + '</select>'
            + '<button class="category-action-btn" onclick="clearFocus()" title="Exit Focus">&#127919; <span>Exit Focus</span></button>'
            + (!isDetachedParkingCard
                ? '<button class="category-action-btn" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" data-cat="' + safeCatHtml + '" onclick="openCategorySettings(this.dataset.cat, undefined, this.dataset.ws)" title="Settings">&#9881; <span>Settings</span></button>'
                : '')
            + (!isDetachedParkingCard && visibleHeaderButtons.has('launch')
                ? '<button class="category-action-btn" data-ws="' + escapeCardHtml(activeWorkspaceId) + '" data-cat="' + safeCatHtml + '" onclick="launchCategory(this.dataset.cat, this.dataset.ws)" title="Launch">&#128640; <span>Launch</span></button>'
                : '')
            + '</div>'
            : ''
            + '<div class="card-header-icon-row" onwheel="handleCardHeaderIconRowWheel(event)">'
            + '<button class="card-header-icon-btn bulk-scope-btn" data-scope-category="' + safeCatHtml + '" data-scope-workspace="' + escapeCardHtml(activeWorkspaceId) + '" onclick="bulkToggleCardScopeSelection(this.dataset.scopeCategory, this.dataset.scopeWorkspace)" title="Select Card">&#9744;</button>'
            + nonFocusButtons.join('')
            + '</div>';

        var subTabSourcesHtml = api.buildSubTabSourcesHtml(catLinks, options, cardWorkspaceId, activeWorkspaceId, isDetachedParkingCard);
        var cardDescription = api.getCardDescription
            ? api.getCardDescription(activeWorkspaceId, cat)
            : '';
        var safeCardDescriptionHtml = escapeCardHtml(cardDescription);

        card.innerHTML = ''
            + '<div class="cat-progress-bg"><div class="cat-progress-fill ' + barClass + '" style="width:' + pct + '%"></div></div>'
            + '<div class="category-header" oncontextmenu="showCategoryContextMenu(event, \'' + safeCatJs + '\', \'' + activeWorkspaceId + '\')">'
            + '<div class="cat-title-group">'
            + titleControlsHtml
            + '<div class="category-title-wrap"'
            + ' data-title="' + safeCatHtml + '"'
            + ' data-description="' + safeCardDescriptionHtml + '"'
            + ' data-ws="' + escapeCardHtml(activeWorkspaceId) + '"'
            + ' data-cat="' + safeCatHtml + '"'
            + (isFocusMode ? '' : ' draggable="true"')
            + (isFocusMode ? '' : ' ondragstart="if(typeof dragCategoryCard===\'function\') dragCategoryCard(event, this.dataset.ws, this.dataset.cat)"')
            + (isFocusMode ? '' : ' ondragend="if(typeof endCategoryCardDrag===\'function\') endCategoryCardDrag(event)"')
            + ' onmouseenter="showCardTitleHover(event, this.dataset.title, this.dataset.description)"'
            + ' onmousemove="moveCardTitleHover(event)"'
            + ' onmouseleave="hideCardTitleHover()">'
            + '<div class="category-title">' + safeCatHtml + '</div>'
            + '</div>'
            + subTabSourcesHtml
            + smartWeightBadgeHtml
            + titleMetaHtml
            + '</div>'
            + headerButtonsHtml
            + '</div>'
            + '<div id="' + libraryPanelId + '" class="lib-panel" style="display:none;"></div>'
            + '<div class="card-folder-view-content">' + listHtml + '</div>'
            + '<div class="category-footer"><span class="stat-pending">Pending: ' + Math.max(totalVisibleTasks - doneVisible, 0) + '</span><span class="stat-done">Done: ' + doneVisible + '</span></div>';
        card.setAttribute('data-card-target-id', cardTargetId);
        card.setAttribute('data-card-category', String(cat || 'Unsorted'));
        card.setAttribute('data-card-workspace', activeWorkspaceId);
        if (isDetachedParkingCard) {
            card.setAttribute('data-detached-parking-card', '1');
        }
        if (typeof api.applyCardPlaceholderSizing === 'function') {
            api.applyCardPlaceholderSizing(card, activeWorkspaceId, cat, catLinks, options);
        }
        if (isSubTabInParentView) {
            card.setAttribute('data-card-subtab-parent-view', '1');
        }

        gridContainer.appendChild(card);
        if (typeof api.captureRenderedCardHeight === 'function') {
            api.captureRenderedCardHeight(card, activeWorkspaceId, cat);
        }

        if (!options._skipFolderRestore && window.EveFolderViewV2 && window.EveFolderViewV2.restoreActiveFolderState) {
            if (isSubTabInParentView && typeof window.EveFolderViewV2.queueRestoreActiveFolderState === 'function') {
                window.EveFolderViewV2.queueRestoreActiveFolderState(activeWorkspaceId, cat, {
                    delayMs: 24,
                    visibleOnly: true
                });
            } else {
                window.EveFolderViewV2.restoreActiveFolderState(activeWorkspaceId, cat);
            }
        }
    }

    Object.assign(api, {
        _renderCardFull: renderCardFull
    });

    api.cardRenderFullReady = true;
})();
