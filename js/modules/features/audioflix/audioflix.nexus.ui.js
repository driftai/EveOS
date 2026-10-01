// Renderers for the Nexus Audio Link search panel (music + soundboard, backend + frontend). Kept
// out of audioflix.ui.js: the panel has a live search box, facet chips (artists / groups / folders
// / duration), and a "manage duplicates" filter that routes each hit into its settings panel where
// the existing merge/keep-both tools live. Results render into their own container so typing can
// refresh just that container without losing input focus.
window.EveAudioflixNexusUi = window.EveAudioflixNexusUi || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixNexusUi;
    if (ns.ready) return;

    // The results list scrolls inside itself (max-height + overflow-y), so restoring the outer
    // panel's scroll does nothing for it. Every rerender rebuilt it at the top -- and playing a
    // track rerenders -- so pressing Play on anything below the fold threw you back to the top of
    // the list. Keyed by type, because music and sounds each have their own container.
    ns.captureScroll = function captureScroll(root) {
        const seen = new Map();
        (root ? root.querySelectorAll('[data-af-nexus-results]') : []).forEach((element) => {
            seen.set(element.dataset.afNexusResults, element.scrollTop);
        });
        return seen;
    };

    ns.restoreScroll = function restoreScroll(root, seen) {
        if (!root || !seen) return;
        root.querySelectorAll('[data-af-nexus-results]').forEach((element) => {
            const top = seen.get(element.dataset.afNexusResults);
            if (top) element.scrollTop = top;
        });
    };

    let expandedSections = { artist: false, group: false, folder: false, duration: false, classifier: false };
    const lastMatchCounts = { music: 0, sound: 0 };

    ns.toggleSection = function toggleSection(sec) {
        if (sec in expandedSections) expandedSections[sec] = !expandedSections[sec];
    };

    ns.create = function create(deps) {
        const esc = deps.esc;
        const getNexus = deps.getNexusState;   // () -> { open, type, query, facet }
        const getPorted = deps.getPorted;      // () -> ported sounds array (soundboard only)
        const X = () => window.EveAudioflixNexus;
        const bulkUi = window.EveAudioflixNexusBulkUi?.create?.({
            esc,
            getNexusState: getNexus
        });

        function renderButton(type) {
            const st = getNexus();
            const active = st.open && st.type === type;
            return `<span class="audioflix-nexus-launch" style="margin-left:8px;"><button type="button" class="audioflix-add-toggle audioflix-nexus-main${active ? ' is-active' : ''}" data-af-action="toggle-nexus" data-af-type="${esc(type)}" title="Open Nexus Audio Link">🔎 Nexus Audio Link</button><button type="button" class="audioflix-add-toggle audioflix-nexus-quick-trigger" data-af-action="open-nexus-quick" data-af-type="${esc(type)}" title="Fast Track search this visible scope" aria-label="Fast Track Nexus search">⌕</button></span>`;
        }

        function filteredList(type) {
            const st = getNexus();
            const api = X();
            const external = type === 'sound' ? api.items(type, getPorted() || []) : null;
            return api.filter({
                type,
                query: st.query,
                facet: st.facet,
                list: external
            });
        }

        function rowHtml(it, type, selectedIds, linkedIds) {
            const meta = [it.artist, it.folder || it.card || it.category].filter(Boolean).join(' · ');
            const dupLevel = window.EveAudioflixDuplicates?.duplicateLevelFor?.(type, it.id) || '';
            const dupBadge = dupLevel ? ` <span style="color:${dupLevel === 'soft' ? '#fbbf24' : '#f87171'}; font-size:0.7rem;">👯 ${dupLevel === 'soft' ? 'soft dup' : 'dup'}</span>` : '';
            const linkBadge = (type === 'music' && linkedIds?.has?.(it.id)) ? ' <span style="color:#38bdf8; font-size:0.7rem;" title="Linked to current surface">🔗 linked</span>' : '';
            const audioStatus = window.EveAudioflixAudio?.getStatus?.();
            const isCurrent = audioStatus?.item?.id === it.id;
            const isPlaying = isCurrent && (audioStatus?.playback?.playing || (audioStatus?.playback && !audioStatus?.playback?.paused)) && audioStatus?.status !== 'Idle' && audioStatus?.status !== 'Paused';

            const actionBtn = isPlaying
                ? `<button type="button" class="audioflix-icon-btn danger" data-af-action="stop-item" data-af-type="${esc(type)}" data-af-id="${esc(it.id)}" title="Stop" style="color:#f87171; border-color:rgba(248,113,113,0.4);">⏹</button>`
                : `<button type="button" class="audioflix-icon-btn" data-af-action="play" data-af-type="${esc(type)}" data-af-id="${esc(it.id)}" title="Play">▶</button>`;

            const selected = type === 'music' && selectedIds.has(it.id);
            const checkbox = type === 'music'
                ? `<input class="audioflix-nexus-select" type="checkbox" data-af-id="${esc(it.id)}"${selected ? ' checked' : ''} aria-label="Select ${esc(it.title)}">`
                : '';
            return `<div class="audioflix-nexus-row${selected ? ' is-selected' : ''}">${checkbox}${actionBtn}<div style="flex:1; min-width:0;"><strong style="display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${isPlaying ? 'color:#38bdf8;' : ''}">${esc(it.title)}${dupBadge}${linkBadge}</strong><span style="font-size:0.75rem; color:#94a3b8;">${esc(meta) || '—'}</span></div><button type="button" class="audioflix-icon-btn" data-af-action="item-info" data-af-type="${esc(type)}" data-af-id="${esc(it.id)}" title="Settings / manage duplicate">⚙</button></div>`;
        }

        function renderResults(type, preparedList) {
            const st = getNexus();
            const list = Array.isArray(preparedList) ? preparedList : filteredList(type);
            lastMatchCounts[type === 'sound' ? 'sound' : 'music'] = list.length;
            if (st.query) X().recordSearch(st.query, type, list.length);
            const selectedIds = new Set(st.selectedIds || []);
            const currentScope = window.EveAudioflixLinks?.inferCurrentScope?.();
            const linkedCapture = (type === 'music' && currentScope && window.EveAudioflixLinks?.captureForScope)
                ? window.EveAudioflixLinks.captureForScope(currentScope, { directOnly: true })
                : null;
            const linkedIds = new Set((linkedCapture?.items || []).map((it) => it.id));
            const shown = list.slice(0, 80).map((it) => rowHtml(it, type, selectedIds, linkedIds)).join('');
            const more = list.length > 80 ? `<div style="padding:6px 8px; color:#94a3b8; font-size:0.75rem;">Showing first 80 of ${list.length}.</div>` : '';
            return (shown || '<div style="color:#94a3b8; padding:10px;">No matches.</div>') + more;
        }

        function chip(kind, val, label, count, active) {
            const on = active;
            return `<button type="button" data-af-action="nexus-facet" data-af-facet="${esc(kind + '::' + val)}" style="font-size:0.72rem; padding:2px 8px; border-radius:12px; border:1px solid rgba(148,163,184,0.35); background:${on ? 'rgba(56,189,248,0.35)' : 'rgba(148,163,184,0.12)'}; color:${on ? '#38bdf8' : '#e2e8f0'}; cursor:pointer; margin:2px; font-weight:${on ? '700' : 'normal'};" title="${on ? 'Click to deselect' : 'Click to filter'}">${esc(label)}${count != null ? ` (${count})` : ''}</button>`;
        }

        function renderPanel(type) {
            const st = getNexus();
            const api = X();
            const all = api.items(type, type === 'sound' ? (getPorted() || []) : []);
            const f = api.facets(type, all);
            const dup = api.dupReport(type, all);
            const dupCount = dup.hard.length + dup.soft.length;
            const integrity = api.integrityReport?.() || {};

            const [activeKind] = String(st.facet || '').split('::');

            const sectionRow = (secKey, title, count, chips) => {
                if (!chips || !count) return '';
                const isOpen = expandedSections[secKey] || activeKind === secKey || (secKey === 'duration' && (activeKind === 'around' || activeKind === 'below'));
                const toggleBtn = `<button type="button" class="audioflix-add-toggle${isOpen ? ' is-active' : ''}" data-af-action="toggle-nexus-section" data-af-section="${esc(secKey)}" style="font-size:0.72rem; padding:2px 8px; border-radius:10px; cursor:pointer;">${isOpen ? '▲' : '▼'} ${esc(title)} (${count})</button>`;
                return `<div style="margin-top:6px;"><div style="display:flex; align-items:center; gap:6px;">${toggleBtn}</div>${isOpen ? `<div style="display:flex; flex-wrap:wrap; gap:2px; margin-top:4px; padding-left:4px;">${chips}</div>` : ''}</div>`;
            };

            const dupChip = dupCount
                ? chip('dups', '1', `👯 Duplicates`, dupCount, st.facet === 'dups::1') + `<span style="font-size:0.7rem; color:#94a3b8; margin-left:6px;">${dup.hard.length} hard · ${dup.soft.length} soft; open a hit's ⚙ to review</span>`
                : '<span style="font-size:0.75rem; color:#94a3b8;">No duplicate names detected.</span>';
            const artistChips = f.artists.slice(0, 14).map((a) => chip('artist', a.name, a.name, a.count, st.facet === `artist::${a.name}`)).join('');
            const groupChips = f.groups.slice(0, 14).map((g) => chip('group', g.name, g.name, g.count, st.facet === `group::${g.name}`)).join('');
            const folderChips = f.folders.slice(0, 14).map((x) => chip('folder', x.name, x.name, x.count, st.facet === `folder::${x.name}`)).join('');
            const durChips = type === 'music' ? f.durations.map((d) => chip('around', String(d.min), `~${d.min} min`, d.count, st.facet === `around::${d.min}`)).join('') : '';
            const belowChips = type === 'music'
                ? f.durations.map((d) => d.min).filter((m) => m > 0).map((m) => chip('below', String(m), `< ${m} min`, null, st.facet === `below::${m}`)).join('')
                : '';
            const combinedDurChips = (durChips || belowChips) ? (durChips + belowChips) : '';
            // Classifier scope: the standalone classifier system (time filter, group rank, manual).
            const classifierEntries = window.EveAudioflixClassifiers?.selectableEntries?.() || [];
            const classifierChips = type === 'music' && deps.renderClassifierChips ? deps.renderClassifierChips(st.facet) : '';
            const classifierCount = type === 'music' ? classifierEntries.length : 0;

            const clearBtn = st.facet ? `<button type="button" class="audioflix-icon-btn" data-af-action="nexus-facet" data-af-facet="${esc(st.facet)}" title="Clear filter">✕</button>` : '';
            const filtered = filteredList(type);
            const bulkManager = bulkUi?.render?.(type, filtered.length) || '';
            const protection = `<div style="margin:6px 0; padding:6px 8px; border-radius:8px; background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.24); color:#a7f3d0; font-size:0.72rem;">Recovery shadow: ${integrity.protected ? 'ready' : 'pending'} · ${Number(integrity.recoveryEntries || 0)} protected items · ${Number(integrity.staleBindings || 0) + Number(integrity.orphanPlaylistLinks || 0)} reference issue(s)</div>`;
            return `<div class="audioflix-nexus-panel" style="margin-top:8px; padding:12px; border-radius:12px; background:rgba(2,6,23,0.55); border:1px solid rgba(148,163,184,0.25);"><div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;"><span style="font-size:0.78rem; font-weight:700; color:#38bdf8; letter-spacing:0.5px;">🔎 NEXUS AUDIO LINK</span><button type="button" class="audioflix-add-toggle" data-af-action="open-nexus-search" style="background:linear-gradient(135deg,rgba(56,189,248,0.25),rgba(14,165,233,0.35)); border:1px solid rgba(56,189,248,0.5); color:#38bdf8; font-weight:700; font-size:0.75rem; padding:4px 10px; border-radius:10px; cursor:pointer;" title="Open Nexus Main Search Modal">⚔ Open Nexus Search</button></div>${protection}<div style="display:flex; align-items:center; gap:8px;"><input type="text" data-af-nexus-search data-af-type="${esc(type)}" value="${esc(st.query)}" placeholder="Search ${type === 'music' ? 'tracks' : 'sounds'} by name, artist, folder, group..." style="flex:1; padding:6px 10px; border-radius:10px; border:1px solid rgba(148,163,184,0.35); background:rgba(0,0,0,0.3); color:#f8fafc;">${clearBtn}</div>${bulkManager}<div style="margin-top:6px;"><span style="font-size:0.72rem; color:#94a3b8; font-weight:700;">Manage duplicates</span><div style="display:flex; flex-wrap:wrap; gap:2px; margin-top:2px;">${dupChip}</div></div>${sectionRow('artist', 'Artists', f.artists.length, artistChips)}${sectionRow('group', 'Groups', f.groups.length, groupChips)}${sectionRow('folder', 'Folders', f.folders.length, folderChips)}${sectionRow('duration', 'Duration Filters', f.durations.length, combinedDurChips)}${sectionRow('classifier', 'Classifiers', classifierCount, classifierChips)}<div class="audioflix-nexus-results" data-af-nexus-results="${esc(type)}" style="margin-top:8px; max-height:300px; overflow-y:auto; border-top:1px solid rgba(255,255,255,0.08);">${renderResults(type, filtered)}</div></div>`;
        }

        return {
            renderButton,
            renderPanel,
            renderResults,
            getLastMatchCount: (type) => lastMatchCounts[type === 'sound' ? 'sound' : 'music']
        };
    };

    ns.ready = true;
})();
