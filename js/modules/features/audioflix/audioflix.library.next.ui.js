window.EveAudioflixLibraryNextUi = window.EveAudioflixLibraryNextUi || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixLibraryNextUi;
    if (ns.ready) return;

    function pruneGroupMap() {
        const s = window.EveAudioflixState?.ensure?.();
        if (!s) return;
        const liveIds = new Set((s.music || []).map((item) => item.id));
        const current = s.musicGroupMap || {};
        const next = Object.fromEntries(Object.entries(current).filter(([id]) => liveIds.has(id)));
        if (Object.keys(next).length !== Object.keys(current).length) {
            window.EveAudioflixState?.update?.({ musicGroupMap: next }, 'audioflix-prune-orphan-group-memberships');
        }
    }

    function audioflixOverlay() {
        return document.getElementById('audioflix-overlay');
    }

    function syncQueueRebase() {
        const q = window.__eveAudioflixQueueRebase;
        if (!q) return;
        const name = String(q.groupName || '');
        if (!name) return;
        const overlay = audioflixOverlay();
        if (!overlay) return;
        const grid = [...overlay.querySelectorAll('.audioflix-item-grid[data-af-active-group]')]
            .find((node) => node.dataset.afActiveGroup === name);
        if (grid) q.group = grid;
    }

    function addMarker(card) {
        const next = window.EveAudioflixLibraryNext;
        if (!next?.health || !next?.prefs || !card) return;
        const play = card.querySelector('[data-af-action="play"][data-af-type="music"]');
        const row = card.querySelector('.audioflix-item-title-row');
        if (!play || !row) return;
        const id = play.dataset.afId;
        if (!id || row.querySelector('.eve-url-health-badge')) return;
        const item = next.health(id);
        if (!item?.status) return;
        const pref = next.prefs(id);
        if (item.status === 'down' && !pref.hideDown) {
            const marker = document.createElement('span');
            marker.className = 'eve-url-health-badge is-down';
            marker.title = 'URL checked when played and is currently unavailable';
            marker.textContent = '● URL Down';
            row.insertBefore(marker, row.querySelector('strong') || null);
        } else if (item.status === 'live' && pref.showLive) {
            const marker = document.createElement('span');
            marker.className = 'eve-url-health-badge is-live';
            marker.title = 'URL checked when played and is currently live';
            marker.textContent = '● Live URL';
            row.insertBefore(marker, row.querySelector('strong') || null);
        }
    }

    function injectMarkers(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.matches?.('.audioflix-item-card')) addMarker(root);
        root.querySelectorAll?.('.audioflix-item-card').forEach(addMarker);
    }

    function containsAudioflixCard(root) {
        if (!root || root.nodeType !== 1) return false;
        return !!(root.matches?.('.audioflix-item-card') || root.querySelector?.('.audioflix-item-card'));
    }

    function containsQueueGrid(root) {
        if (!root || root.nodeType !== 1) return false;
        return !!(
            root.matches?.('.audioflix-item-grid[data-af-active-group]') ||
            root.querySelector?.('.audioflix-item-grid[data-af-active-group]')
        );
    }

    function handleOverlayMutations(records) {
        let shouldSyncQueue = false;
        let shouldPruneGroups = false;
        records.forEach((record) => {
            record.addedNodes.forEach((node) => {
                if (node?.nodeType !== 1) return;
                if (containsAudioflixCard(node)) injectMarkers(node);
                if (containsQueueGrid(node)) shouldSyncQueue = true;
            });
            record.removedNodes.forEach((node) => {
                if (node?.nodeType !== 1) return;
                if (containsAudioflixCard(node)) shouldPruneGroups = true;
                if (containsQueueGrid(node)) shouldSyncQueue = true;
            });
        });
        if (shouldPruneGroups) pruneGroupMap();
        if (shouldSyncQueue) syncQueueRebase();
    }

    function installOverlayObserver() {
        let overlayObserver = null;
        let bodyObserver = null;

        const connect = () => {
            const overlay = audioflixOverlay();
            if (!overlay || overlayObserver) return false;
            injectMarkers(overlay);
            syncQueueRebase();
            overlayObserver = new MutationObserver(handleOverlayMutations);
            overlayObserver.observe(overlay, { childList: true, subtree: true });
            bodyObserver?.disconnect();
            bodyObserver = null;
            return true;
        };

        if (connect()) return;

        // AudioFlix appends its overlay directly to document.body. Watch only body children until
        // that one root exists; never subscribe AudioFlix maintenance to the rest of EveOS/Gemini.
        bodyObserver = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node?.nodeType === 1 && node.id === 'audioflix-overlay') {
                        connect();
                        return;
                    }
                }
            }
        });
        bodyObserver.observe(document.body, { childList: true });
    }

    function boot() {
        if (ns.booted || !document.body) return;
        ns.booted = true;

        // State cleanup is independent of page DOM. Runtime UI work begins only after the stable
        // AudioFlix overlay exists, so Search Monitor/Gemini mutations cannot drive this module.
        pruneGroupMap();
        installOverlayObserver();

        document.addEventListener('click', (event) => {
            const play = event.target?.closest?.('[data-af-action="play"][data-af-type="music"]');
            if (!play) return;
            const badge = play.closest('.audioflix-item-card')?.querySelector('.audioflix-queue-badge');
            const match = badge?.textContent?.match(/#(\d+)/);
            if (!match) return;
            const grid = play.closest('.audioflix-item-grid');
            window.__eveAudioflixQueueRebase = {
                position: Number(match[1]),
                groupName: grid?.dataset?.afActiveGroup || '',
                group: grid || null
            };
            setTimeout(syncQueueRebase, 0);
        }, true);
    }

    Object.assign(ns, { ready: true, boot, pruneGroupMap });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();