function moveCategory(cat, direction, workspaceId) {
    workspaceId = String(workspaceId || config.activeWorkspace || 'main').trim() || 'main';
    if (window.EveCategoryOrder?.moveCategory) {
        if (window.EveCategoryOrder.moveCategory(workspaceId, cat, direction)) {
            saveConfig();
            if (typeof renderDashboard === 'function') renderDashboard();
        }
        return;
    }
    const visibleLinks = getCategoryLiveLinks().filter(l => l.workspace === workspaceId);
    const summary = getCategoryStructureSummary();
    let categories = summary?.cards
        ? Object.keys(summary.cards)
            .filter(key => String(key || '').indexOf(workspaceId + '::') === 0)
            .map(key => String(key).slice((workspaceId + '::').length).trim() || 'Unsorted')
        : [];
    if (!categories.length) {
        categories = [...new Set(visibleLinks.map(l => l.category || "Unsorted"))];
    }
    if (!config.categoryOrder || config.categoryOrder.length === 0) config.categoryOrder = categories.sort();
    categories.forEach(c => { if (!config.categoryOrder.includes(c)) config.categoryOrder.push(c); });
    const idx = config.categoryOrder.indexOf(cat);
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx >= 0 && newIdx < config.categoryOrder.length) {
        const temp = config.categoryOrder[newIdx];
        config.categoryOrder[newIdx] = config.categoryOrder[idx];
        config.categoryOrder[idx] = temp;
        saveConfig();
        if (typeof renderDashboard === 'function') renderDashboard();
    }
}

async function promptMoveCategory(cat, currentIndex, workspaceId, anchorEl) {
    workspaceId = String(workspaceId || config.activeWorkspace || 'main').trim() || 'main';
    var order = window.EveCategoryOrder && window.EveCategoryOrder.getOrder
        ? window.EveCategoryOrder.getOrder(workspaceId)
        : [];
    var totalCards = Array.isArray(order) ? order.length : 0;
    if (totalCards === 0) return;

    var resolvedIndex = Array.isArray(order) ? order.indexOf(String(cat || '').trim()) : -1;
    var fallbackIndex = parseInt(currentIndex, 10);
    var currentPosition = resolvedIndex >= 0
        ? (resolvedIndex + 1)
        : (!isNaN(fallbackIndex) && fallbackIndex >= 0 ? (fallbackIndex + 1) : 1);

    var promptLabel = "Move card to position (1 to " + totalCards + "):";
    var rawValue = null;
    if (window.EveInlinePrompt && typeof window.EveInlinePrompt.show === 'function') {
        rawValue = await window.EveInlinePrompt.show({
            label: promptLabel,
            value: String(currentPosition),
            type: 'number',
            min: 1,
            max: totalCards,
            step: 1,
            inputMode: 'numeric',
            anchor: anchorEl || null
        });
    } else if (typeof window.showPrompt === 'function') {
        rawValue = await window.showPrompt(promptLabel, String(currentPosition));
    } else {
        rawValue = null;
    }

    if (rawValue === null || rawValue === undefined) return;
    var nextValue = String(rawValue).trim();
    if (!nextValue) return;

    var parsed = parseInt(nextValue, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > totalCards) {
        if (typeof window.showToast === 'function') {
            window.showToast("Enter a card position between 1 and " + totalCards + ".", 'warning');
        }
        return;
    }

    if (window.EveCategoryOrder && window.EveCategoryOrder.moveCategoryToPosition) {
        if (window.EveCategoryOrder.moveCategoryToPosition(workspaceId, cat, parsed)) {
            saveConfig();
            if (typeof renderDashboard === 'function') renderDashboard();
        }
    }
}

function toggleCollapse(cat, workspaceId) {
    if (!config.collapsed) config.collapsed = [];
    const wsId = String(workspaceId || config.activeWorkspace || 'main').trim();
    const key = `${wsId}::${cat}`;
    var wasCollapsed = config.collapsed.includes(key) || config.collapsed.includes(cat);
    if (wasCollapsed) {
        config.collapsed = config.collapsed.filter(c => c !== key && c !== cat);
    } else {
        config.collapsed.push(key);
    }
    saveConfig();

    // Direct DOM toggle — avoid full re-render for a CSS-only change
    var card = findCategoryCard(wsId, cat);
    if (card) {
        card.classList.toggle('collapsed', !wasCollapsed);
        // If expanding a deferred card, trigger its full build
        if (wasCollapsed && card.getAttribute('data-card-deferred') === '1') {
            if (typeof renderDashboard === 'function') renderDashboard();
        }
    } else {
        if (typeof renderDashboard === 'function') renderDashboard();
    }
}

function toggleFolderCollapse(cat, workspaceId) {
    if (!config.foldersCollapsed) config.foldersCollapsed = [];
    const wsId = String(workspaceId || config.activeWorkspace || 'main').trim();
    const key = `${wsId}::${cat}`;
    const wasCollapsed = config.foldersCollapsed.includes(key) || config.foldersCollapsed.includes(cat);
    if (wasCollapsed) {
        config.foldersCollapsed = config.foldersCollapsed.filter(c => c !== key && c !== cat);
    } else {
        config.foldersCollapsed.push(key);
    }
    saveConfig();

    // Direct DOM toggle — avoid full re-render for a CSS-only change
    var card = findCategoryCard(wsId, cat);
    if (card) {
        card.classList.toggle('folders-collapsed', !wasCollapsed);
    } else {
        if (typeof renderDashboard === 'function') renderDashboard();
    }
}

function toggleLinksCollapse(cat, workspaceId) {
    if (!config.linksCollapsed) config.linksCollapsed = [];
    const wsId = String(workspaceId || config.activeWorkspace || 'main').trim();
    const key = `${wsId}::${cat}`;
    const wasCollapsed = config.linksCollapsed.includes(key) || config.linksCollapsed.includes(cat);
    if (wasCollapsed) {
        config.linksCollapsed = config.linksCollapsed.filter(c => c !== key && c !== cat);
    } else {
        config.linksCollapsed.push(key);
    }
    saveConfig();

    // Direct DOM toggle — avoid full re-render for a CSS-only change
    var card = findCategoryCard(wsId, cat);
    if (card) {
        card.classList.toggle('links-collapsed', !wasCollapsed);
    } else {
        if (typeof renderDashboard === 'function') renderDashboard();
    }
}

function toggleSubfoldersCollapse(folderId, workspaceId) {
    if (!config.subfoldersCollapsed) config.subfoldersCollapsed = [];
    const wsId = String(workspaceId || config.activeWorkspace || 'main').trim();
    const key = `${wsId}::${folderId}`;
    const wasCollapsed = config.subfoldersCollapsed.includes(key) || config.subfoldersCollapsed.includes(folderId);
    if (wasCollapsed) {
        config.subfoldersCollapsed = config.subfoldersCollapsed.filter(id => id !== key && id !== folderId);
    } else {
        config.subfoldersCollapsed.push(key);
    }
    saveConfig();

    // Perf mode: patch DOM directly, skip full re-render
    if (window._evePerfMode) {
        document.querySelectorAll('.bookmark-folder-group, .bookmark-folder-root-group, .manhwa-frame').forEach(function (el) {
            if (!wasCollapsed) el.classList.add('subfolders-collapsed');
            // Check if this element is relevant by seeing if folderId matches
        });
        // Re-enter current folder for folder-view cards
        const activeFolder = window.EveFolderViewV2?._activeFolderStates;
        if (activeFolder) {
            for (const [key, state] of Object.entries(activeFolder)) {
                if (state?.folderId === folderId || state?.folderId) {
                    const [ws, cat] = key.split('::');
                    if (ws && cat) window.EveFolderViewV2.enterFolder(null, cat, state.folderId, ws);
                }
            }
        }
        return;
    }
    if (typeof renderDashboard === 'function') renderDashboard();
}

function toggleSublinksCollapse(folderId, workspaceId) {
    if (!config.sublinksCollapsed) config.sublinksCollapsed = [];
    const wsId = String(workspaceId || config.activeWorkspace || 'main').trim();
    const key = `${wsId}::${folderId}`;
    const wasCollapsed = config.sublinksCollapsed.includes(key) || config.sublinksCollapsed.includes(folderId);
    if (wasCollapsed) {
        config.sublinksCollapsed = config.sublinksCollapsed.filter(id => id !== key && id !== folderId);
    } else {
        config.sublinksCollapsed.push(key);
    }
    saveConfig();

    // Perf mode: re-enter current folder to re-render with collapse state
    if (window._evePerfMode) {
        const activeFolder = window.EveFolderViewV2?._activeFolderStates;
        if (activeFolder) {
            for (const [key, state] of Object.entries(activeFolder)) {
                if (state?.folderId === folderId || state?.folderId) {
                    const [ws, cat] = key.split('::');
                    if (ws && cat) window.EveFolderViewV2.enterFolder(null, cat, state.folderId, ws);
                }
            }
        }
        return;
    }
    if (typeof renderDashboard === 'function') renderDashboard();
}

function setFocus(cat) {
    focusCategory = cat;
    if (window.EveDashboardHydrationMemory?.recordCardInteraction) {
        window.EveDashboardHydrationMemory.recordCardInteraction(config.activeWorkspace || 'main', cat, 'focus');
    }
    if (typeof renderDashboard === 'function') renderDashboard();
}

function clearFocus() {
    window.EveDashboardHydrationMemory?.flushActiveCardDwell?.('dashboard-hydration-memory-focus-dwell');
    focusCategory = null;
    if (typeof renderDashboard === 'function') renderDashboard();
}

// Launch must use the click's transient user activation. Synthetic anchor.click() does
// not prove that the browser created a tab, especially on localhost/file pages.
function getCardLaunchUrl(raw) {
    const source = String(raw || '').trim();
    if (!source || /[\u0000-\u001f\u007f]/.test(source)) return '';
    if (/^(?:javascript|data|vbscript|blob):/i.test(source)) return '';
    try {
        const parsed = new URL(normalizeUrl(source));
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname
            && !parsed.username && !parsed.password) return parsed.href;
        // Browsers disallow file links launched from localhost. Preserve file mode only.
        if (parsed.protocol === 'file:' && window.location.protocol === 'file:') return parsed.href;
    } catch {}
    return '';
}

function showCardLaunchBlockedLinks(urls) {
    document.getElementById('eve-card-launch-blocked-links')?.remove();
    const panel = document.createElement('section');
    panel.id = 'eve-card-launch-blocked-links';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Card links blocked by browser');
    Object.assign(panel.style, {
        position: 'fixed', zIndex: '2147483600', right: '16px', bottom: '16px',
        maxWidth: 'min(500px, calc(100vw - 32px))', maxHeight: '60vh',
        overflowY: 'auto', padding: '16px', borderRadius: '12px',
        color: '#fff', background: '#172025', border: '1px solid #7d969d',
        boxShadow: '0 8px 30px #0009'
    });
    const title = document.createElement('strong');
    title.textContent = urls.length + ' card link(s) need a click';
    const info = document.createElement('p');
    info.textContent = 'Your browser blocked bulk tabs. Allow popups for EveOS, or open each link below.';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => panel.remove());
    const list = document.createElement('ol');
    urls.forEach((url) => {
        const item = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = url;
        anchor.style.color = '#9de5ff';
        item.appendChild(anchor);
        list.appendChild(item);
    });
    panel.append(title, info, close, list);
    document.body.appendChild(panel);
}

async function launchCategory(catName, workspaceId) {
    const scope = String(workspaceId || config.activeWorkspace || 'main').trim() || 'main';
    const seen = new Set();
    const urls = getCategoryLiveLinks()
        .filter(link => String(link?.category || 'Unsorted') === String(catName || 'Unsorted')
            && !link?.done && String(link?.workspace || 'main') === scope)
        .map(link => getCardLaunchUrl(link.url))
        .filter(url => {
            if (!url) return false;
            if (seen.has(url)) return false;
            seen.add(url);
            return true;
        });
    if (!urls.length) {
        if (typeof showToast === 'function') showToast('This card has no openable URLs.', 'info');
        return { total: 0, opened: 0, blocked: 0 };
    }
    if (urls.length > 5 && !(await showConfirm(`Open ${urls.length} tabs?`))) {
        return { total: urls.length, opened: 0, blocked: 0, cancelled: true };
    }

    const blocked = [];
    let opened = 0;
    // Only a bounded number of automatic popups; provide native clickable links
    // for everything else. A popup blocker may permit just one tab per gesture.
    const automaticLimit = 20;
    urls.forEach((url, index) => {
        if (index >= automaticLimit) { blocked.push(url); return; }
        let tab = null;
        try {
            tab = window.open('about:blank', '_blank');
            if (!tab) { blocked.push(url); return; }
            tab.opener = null; // Drop opener access BEFORE navigating externally.
            tab.location.replace(url);
            opened++;
        } catch {
            try { tab?.close(); } catch {}
            blocked.push(url);
        }
    });
    if (blocked.length) {
        showCardLaunchBlockedLinks(blocked);
        if (typeof showToast === 'function') {
            showToast(`${blocked.length} tab(s) blocked; click links in the recovery panel.`, 'warning');
        }
    }
    return { total: urls.length, opened, blocked: blocked.length };
}
