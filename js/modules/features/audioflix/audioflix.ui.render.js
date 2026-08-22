// Card / grid / frontend renderers for the Audioflix panel. Split out of audioflix.ui.js to keep
// that view under the line cap. Frontend include scopes remain in EveAudioflixState; exclusions are
// persisted separately so old Audioflix states/backups remain compatible.
window.EveAudioflixUiRender = window.EveAudioflixUiRender || {};

(function installFrontendFilters() {
    'use strict';

    const STORE_KEY = 'eveAudioflixFrontendExclusionsV1';
    const EMPTY = { soundGroups: [], musicGroups: [], musicArtists: [], musicClassifiers: [] };
    const unique = (values) => [...new Set((Array.isArray(values) ? values : []).map((v) => String(v || '').trim()).filter(Boolean))];
    const load = () => {
        try {
            const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
            return Object.fromEntries(Object.keys(EMPTY).map((key) => [key, unique(raw?.[key])]));
        } catch (_) {
            return { ...EMPTY };
        }
    };
    const excluded = load();
    const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(excluded)); } catch (_) {} };
    const get = (key) => unique(excluded[key]);
    const set = (key, values) => { excluded[key] = unique(values); save(); return excluded[key]; };
    const idsFor = (entries, keys) => {
        const wanted = new Set(keys);
        const ids = new Set();
        (entries || []).forEach(([key, members]) => {
            if (!wanted.has(String(key))) return;
            (members || []).forEach((item) => { if (item?.id) ids.add(item.id); });
        });
        return ids;
    };
    const subtract = (items, entries, keys) => {
        const denied = idsFor(entries, keys);
        return denied.size ? (items || []).filter((item) => !denied.has(item.id)) : (items || []);
    };
    const pillClass = (key, active, bucket) => key === active ? ' is-active' : get(bucket).includes(key) ? ' is-excluded' : '';
    const pillTitle = (key, active, bucket) => key === active ? 'Included — click again to exclude' : get(bucket).includes(key) ? 'Excluded — click again to clear' : 'Click to include';

    const api = window.EveAudioflixFrontendFilters = Object.assign(window.EveAudioflixFrontendFilters || {}, {
        ready: true, get, subtract, pillClass, pillTitle,
        clear(key) { if (Object.prototype.hasOwnProperty.call(EMPTY, key)) set(key, []); }
    });

    if (!document.getElementById?.('audioflix-frontend-exclusion-style')) {
        const style = document.createElement('style');
        style.id = 'audioflix-frontend-exclusion-style';
        style.textContent = `
            .audioflix-group-pill.is-excluded { color:#fecaca !important; border-color:rgba(248,113,113,.78) !important; background:rgba(127,29,29,.48) !important; box-shadow:inset 0 0 0 1px rgba(248,113,113,.14); }
            .audioflix-group-pill.is-excluded:hover { color:#fee2e2 !important; border-color:rgba(248,113,113,.96) !important; background:rgba(153,27,27,.58) !important; }
            .audioflix-group-pill.is-excluded .audioflix-group-pill-count { color:#fecaca !important; }
        `;
        document.head?.appendChild(style);
    }

    const configs = {
        'audioflix-active-group': { type: 'sound', dimension: 'group', include: 'activeFrontendGroup', bucket: 'soundGroups' },
        'audioflix-active-music-group': { type: 'music', dimension: 'group', include: 'activeFrontendMusicGroup', bucket: 'musicGroups' },
        'audioflix-active-music-artist': { type: 'music', dimension: 'artist', include: 'activeFrontendMusicArtist', bucket: 'musicArtists' },
        'audioflix-active-music-classifier': { type: 'music', dimension: 'classifier', include: 'activeFrontendMusicClassifier', bucket: 'musicClassifiers' }
    };
    let pending = null;
    document.addEventListener?.('click', (event) => {
        const button = event.target?.closest?.('[data-af-action="select-frontend-group"]');
        if (!button) return;
        const target = String(button.dataset.afGroup || '');
        const type = button.dataset.afType === 'music' ? 'music' : 'sound';
        const dimension = button.dataset.afDimension || (target.startsWith('smart:artist:') ? 'artist' : target.startsWith('class:') ? 'classifier' : 'group');
        pending = { type, dimension, target, at: Date.now() };
    }, true);

    const stateApi = window.EveAudioflixState;
    if (stateApi?.update && !stateApi.update.__eveTriStateFilters) {
        const originalUpdate = stateApi.update.bind(stateApi);
        const wrappedUpdate = function (patch, reason) {
            const nextPatch = { ...(patch || {}) };
            const cfg = configs[reason];
            const click = pending && Date.now() - pending.at < 1500 ? pending : null;
            if (cfg && click && click.type === cfg.type && click.dimension === cfg.dimension) {
                pending = null;
                const target = click.target;
                const current = String(stateApi.ensure?.()?.[cfg.include] || '');
                let deny = get(cfg.bucket);
                if (!target) {
                    nextPatch[cfg.include] = '';
                    deny = [];
                } else if (current === target) {
                    // Second click: included -> excluded.
                    nextPatch[cfg.include] = '';
                    deny = unique([...deny, target]);
                } else if (deny.includes(target)) {
                    // Third click: excluded -> neutral. Preserve any other currently included scope.
                    nextPatch[cfg.include] = current;
                    deny = deny.filter((value) => value !== target);
                } else {
                    // First click: neutral -> included.
                    nextPatch[cfg.include] = target;
                    deny = deny.filter((value) => value !== target);
                }
                set(cfg.bucket, deny);
            }
            return originalUpdate(nextPatch, reason);
        };
        wrappedUpdate.__eveTriStateFilters = true;
        stateApi.update = wrappedUpdate;
    }

    const classifierApi = window.EveAudioflixClassifiersUi;
    if (classifierApi?.create && !classifierApi.create.__eveTriStateFilters) {
        const originalCreate = classifierApi.create.bind(classifierApi);
        const wrappedCreate = function (ctx) {
            const base = originalCreate(ctx);
            const esc = ctx.esc;
            base.renderFrontendRow = function (activeKey, scopedEntries) {
                const entries = Array.isArray(scopedEntries) ? scopedEntries : (window.EveAudioflixClassifiers?.selectableEntries?.() || []);
                if (!entries.length) return '';
                const open = ctx.getFrontendOpen();
                const toggle = `<button type="button" class="audioflix-group-pill${open ? ' is-active' : ''}" data-af-action="toggle-classifier-row" title="Show classifier filters">🏷 Classifiers<span class="audioflix-group-pill-count">${entries.length}</span></button>`;
                const pills = open ? entries.map(([key, tracks, label]) => `<button type="button" class="audioflix-group-pill${api.pillClass(key, activeKey, 'musicClassifiers')}" data-af-action="select-frontend-group" data-af-dimension="classifier" data-af-type="music" data-af-group="${esc(key)}" title="${api.pillTitle(key, activeKey, 'musicClassifiers')}">${esc(label)}<span class="audioflix-group-pill-count">${tracks.length}</span></button>`).join('') : '';
                return `<div class="audioflix-group-selector audioflix-classifier-selector"><span class="audioflix-scope-label">Classify:</span>${toggle}${pills}</div>`;
            };
            return base;
        };
        wrappedCreate.__eveTriStateFilters = true;
        classifierApi.create = wrappedCreate;
    }
})();

(function () {
    'use strict';

    const ns = window.EveAudioflixUiRender;
    if (ns.ready) return;

    ns.create = function create(ctx) {
        const esc = ctx.esc;
        const state = ctx.state;
        const filters = window.EveAudioflixFrontendFilters;

        function frontendMusicItems() {
            let items = (state().music || []).filter((it) => ctx.isItemExposed(it, 'music'));
            const scope = state().activeMusicFolderScope || '';
            if (scope) items = items.filter((it) => String(it.folder || it.card || '').trim() === scope);
            return items;
        }

        function frontendMusicSmartEntries(sourceItems) {
            const X = window.EveAudioflixNexus;
            const items = sourceItems || frontendMusicItems();
            const out = [], byArtist = {};
            items.forEach((it) => {
                const artist = X?.getArtist ? X.getArtist(it) : String(it.artist || '').trim();
                if (artist) (byArtist[artist] = byArtist[artist] || []).push(it);
            });
            Object.entries(byArtist)
                .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
                .forEach(([artist, members]) => out.push([`smart:artist:${artist}`, members, `🎤 ${artist}`]));
            return out;
        }

        function frontendGroupEntries(type = 'sound') {
            if (type === 'music') {
                const items = frontendMusicItems(), entries = [];
                ctx.allGroups('music').forEach((group) => {
                    const members = items.filter((it) => ctx.groupsOf(it.id, 'music').includes(group));
                    if (members.length) entries.push([group, members]);
                });
                entries.push(['Ungrouped', items.filter((it) => !ctx.groupsOf(it.id, 'music').length)]);
                return entries;
            }
            const items = [...(state().soundboard || []), ...ctx.getPorted()].filter((it) => ctx.isItemExposed(it, 'sound')), entries = [];
            ctx.allGroups('sound').forEach((group) => {
                const members = items.filter((it) => ctx.groupsOf(it.id, 'sound').includes(group));
                if (members.length) entries.push([group, members]);
            });
            entries.push(['Ungrouped', items.filter((it) => !ctx.groupsOf(it.id, 'sound').length)]);
            return entries;
        }

        function frontendActiveGroup(type = 'sound') {
            const entries = frontendGroupEntries(type);
            if (type === 'music') {
                const baseItems = frontendMusicItems();
                const chosenGroup = entries.find(([name]) => name === (state().activeFrontendMusicGroup || ''));
                const groupCandidates = chosenGroup ? chosenGroup[1] : baseItems;
                const groupItems = filters.subtract(groupCandidates, entries, filters.get('musicGroups'));
                const smart = frontendMusicSmartEntries(groupItems);
                const chosenArtist = smart.find(([key]) => key === (state().activeFrontendMusicArtist || ''));
                const artistCandidates = chosenArtist ? chosenArtist[1] : groupItems;
                const artistItems = filters.subtract(artistCandidates, smart, filters.get('musicArtists'));
                const classifiers = ctx.classifierEntries(artistItems);
                const chosenClassifier = classifiers.find(([key]) => key === (state().activeFrontendMusicClassifier || ''));
                const classifierCandidates = chosenClassifier ? chosenClassifier[1] : artistItems;
                const items = filters.subtract(classifierCandidates, classifiers, filters.get('musicClassifiers'));
                const labels = [chosenGroup?.[0] || 'All Groups', chosenArtist?.[2], chosenClassifier?.[2]].filter(Boolean);
                return {
                    name: labels.join(' / '), items, entries, smart, classifiers,
                    activeGroup: chosenGroup?.[0] || '', activeArtist: chosenArtist?.[0] || '',
                    activeClassifier: chosenClassifier?.[0] || '', displayName: labels.join(' / ')
                };
            }
            const source = [...(state().soundboard || []), ...ctx.getPorted()].filter((it) => ctx.isItemExposed(it, 'sound'));
            const active = String(state().activeFrontendGroup || '');
            const chosen = entries.find(([name]) => name === active);
            const candidates = chosen ? chosen[1] : source;
            return {
                name: chosen?.[0] || 'All Groups',
                items: filters.subtract(candidates, entries, filters.get('soundGroups')),
                entries, activeGroup: chosen?.[0] || ''
            };
        }

        function renderItemCard(item, type) {
            const isF = (type === 'music' ? (state().musicViewMode || 'backend') : (state().soundboardViewMode || 'backend')) === 'frontend';
            const transport = window.EveAudioflixTransport?.render?.(item, type, esc) || '';
            const rep = ctx.getActiveRepeaters()[item.id], repBadge = rep ? `<span class="audioflix-repeater-badge" title="Repeater active">🔁 Rep</span>` : '';
            const keyBadge = isF && type === 'sound' && item.hotkey ? `<span class="audioflix-hotkey-badge" title="Hotkey: press ${esc(item.hotkey)}">${esc(item.hotkey)}</span>` : '';
            const delBtn = !isF && !item.isPorted ? `<button type="button" class="audioflix-icon-btn danger" data-af-action="remove" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}">${ctx.closeSvg}</button>` : '';
            const dupLevel = window.EveAudioflixDuplicates?.duplicateLevelFor?.(type, item.id) || '';
            const dupBadge = dupLevel ? `<span class="audioflix-dup-badge${dupLevel === 'soft' ? ' is-soft' : ''}" title="${dupLevel === 'soft' ? 'Possible same-title or clipped version' : 'Matching source identity detected'}">👯 ${dupLevel === 'soft' ? 'Soft dup' : 'Dup'}</span>` : '';
            const showMarkers = state().showPlaylistMarkersOnCard === true;
            const layerVoices = type === 'sound' ? `<div class="audioflix-layer-voices" data-af-layer-voices="${esc(item.id)}" aria-live="off"></div>` : '';
            const isLibraryOnly = showMarkers && type === 'music' && window.EveAudioflixPlaylists?.isLibraryOnlyTrackInImportedGroup?.(item);
            const localBadge = isLibraryOnly ? `<span class="audioflix-local-badge is-minimized" title="Kept in EveOS; this track is not supplied by the linked playlist" data-af-action="toggle-local-badge"><span class="audioflix-local-badge-icon">⚡</span><span class="audioflix-local-badge-text"> Library-only</span></span>` : '';
            const amq = ctx.getActiveMusicQueue();
            let queueBadge = '';
            if (type === 'music' && amq.isPlaying && amq.items.includes(item.id)) {
                const qIdx = amq.items.indexOf(item.id), pos = qIdx + 1;
                const isCurrent = qIdx === amq.currentIndex, isPast = qIdx < amq.currentIndex;
                const statusText = isCurrent ? 'Playing' : isPast ? 'Played' : 'Queued';
                queueBadge = `<span class="audioflix-queue-badge${isCurrent ? ' is-active' : isPast ? ' is-past' : ''}" title="Queue position #${pos} (${statusText})">#${pos} ${statusText}</span>`;
            }
            return `<article class="audioflix-item-card${item.upstreamMissing && showMarkers ? ' is-upstream-missing' : ''}"><div class="audioflix-playback-controls"><button type="button" class="audioflix-stop" data-af-action="stop-item" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="Stop">${ctx.stopSvg}</button><button type="button" class="audioflix-play" data-af-action="play" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="Play">${ctx.playSvg}</button></div><button type="button" class="audioflix-layer-play" data-af-action="layer-play" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="Layer Play">${ctx.layerPlaySvg}</button><div class="audioflix-item-body"><div class="audioflix-item-title-row">${queueBadge}${dupBadge}${localBadge}${repBadge}${keyBadge}<strong>${esc(item.title)}</strong></div><span>${esc(ctx.itemMeta(item))}</span>${ctx.groupTags(item, ctx.groupsOf(item.id, type))}</div><div class="audioflix-item-actions">${ctx.internalViewButton(item, type)}${item.upstreamMissing && item.playlistId && showMarkers ? `<button type="button" class="audioflix-icon-btn" data-af-action="keep-playlist-track" data-af-id="${esc(item.id)}" title="Removed from the upstream playlist — keep it in EveOS">&#128190;</button>` : ''}<button type="button" class="audioflix-icon-btn" data-af-action="item-info" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="${isF ? 'Settings' : ''}">${ctx.cogSvg}</button>${delBtn}</div>${transport}${layerVoices}</article>`;
        }

        const renderFrontendActive = () => {
            const { name, items, entries, activeGroup } = frontendActiveGroup('sound');
            const exposedCount = [...(state().soundboard || []), ...ctx.getPorted()].filter((it) => ctx.isItemExposed(it, 'sound')).length;
            const all = `<button type="button" class="audioflix-group-pill${activeGroup ? '' : ' is-active'}" data-af-action="select-frontend-group" data-af-type="sound" data-af-group="" title="Clear group include/exclude focus">All Groups<span class="audioflix-group-pill-count">${exposedCount}</span></button>`;
            const pills = entries.map(([group, members]) => `<button type="button" class="audioflix-group-pill${filters.pillClass(group, activeGroup, 'soundGroups')}" data-af-action="select-frontend-group" data-af-type="sound" data-af-group="${esc(group)}" title="${filters.pillTitle(group, activeGroup, 'soundGroups')}">${esc(group)}<span class="audioflix-group-pill-count">${members.length}</span></button>`).join('');
            return `<div class="audioflix-group-selector"><span class="audioflix-scope-label">Group:</span>${all}${pills}</div><div class="audioflix-item-grid" data-af-active-group="${esc(name)}">${items.map((it) => renderItemCard(it, 'sound')).join('')}</div>${items.some((it) => it.hotkey) ? '<div class="audioflix-hotkey-hint">Custom hotkeys are active system-wide.</div>' : ''}`;
        };

        const renderFrontendMusicActive = () => {
            const { name, items, entries, smart, classifiers, activeGroup, activeArtist, activeClassifier, displayName } = frontendActiveGroup('music');
            const musicItems = state().music || [];
            const allFolders = [...new Set(musicItems.map((it) => String(it.folder || it.card || '').trim()).filter(Boolean))];
            const activeScope = state().activeMusicFolderScope || '';
            const classifierRow = ctx.renderClassifierRow ? ctx.renderClassifierRow(activeClassifier, classifiers) : '';
            const scopePills = `<div class="audioflix-folder-scope-selector"><span class="audioflix-scope-label">Track Focus:</span><button type="button" class="audioflix-scope-pill${activeScope === '' ? ' is-active' : ''}" data-af-action="select-folder-scope" data-af-scope="">🌐 All Folders (No Focus)</button>${allFolders.map((folder) => `<button type="button" class="audioflix-scope-pill${activeScope === folder ? ' is-active' : ''}" data-af-action="select-folder-scope" data-af-scope="${esc(folder)}">📁 ${esc(folder)}</button>`).join('')}</div>`;
            const allGroupPill = `<button type="button" class="audioflix-group-pill${activeGroup === '' ? ' is-active' : ''}" data-af-action="select-frontend-group" data-af-dimension="group" data-af-type="music" data-af-group="" title="Clear group include/exclude focus">All Groups (No Focus)<span class="audioflix-group-pill-count">${frontendMusicItems().length}</span></button>`;
            const selector = `<div class="audioflix-group-selector"><span class="audioflix-scope-label">Group:</span>${allGroupPill}${entries.map(([group, members]) => `<button type="button" class="audioflix-group-pill${filters.pillClass(group, activeGroup, 'musicGroups')}" data-af-action="select-frontend-group" data-af-dimension="group" data-af-type="music" data-af-group="${esc(group)}" title="${filters.pillTitle(group, activeGroup, 'musicGroups')}">${esc(group)}<span class="audioflix-group-pill-count">${members.length}</span></button>`).join('')}</div>`;
            const smartOpen = ctx.smartArtistExpanded;
            const smartPills = smart?.length && smartOpen ? smart.map(([key, members, label]) => `<button type="button" class="audioflix-group-pill${filters.pillClass(key, activeArtist, 'musicArtists')}" data-af-action="select-frontend-group" data-af-dimension="artist" data-af-type="music" data-af-group="${esc(key)}" title="${filters.pillTitle(key, activeArtist, 'musicArtists')}">${esc(label)}<span class="audioflix-group-pill-count">${members.length}</span></button>`).join('') : '';
            const smartToggleBtn = smart?.length ? `<button type="button" class="audioflix-add-toggle${smartOpen ? ' is-active' : ''}" data-af-action="toggle-smart-artists" style="font-size:0.75rem; padding:3px 10px; border-radius:12px; cursor:pointer;" title="Toggle artist smart filters">🎤 Artists (${smart.length}) ${smartOpen ? '▲' : '▼'}</button>` : '';
            const smartSelector = smart?.length ? `<div class="audioflix-group-selector audioflix-smart-selector" style="align-items:center; gap:8px;"><span class="audioflix-scope-label">Smart:</span>${smartToggleBtn}${smartPills}</div>` : '';
            const amq = ctx.getActiveMusicQueue(), isQueuePlaying = amq.isPlaying && amq.groupName === name;
            const playGroupBtn = items.length ? (isQueuePlaying ? `<button type="button" class="audioflix-play-group-btn is-active" data-af-action="stop-music-group">⏹ Stop Group</button>` : `<button type="button" class="audioflix-play-group-btn" data-af-action="play-music-group">▶ Play Group</button>`) : '';
            const shuffleBtn = items.length ? `<button type="button" class="audioflix-play-group-btn${amq.shuffle ? ' is-active' : ''}" data-af-action="shuffle-music-group" title="Make the current track #1 and shuffle the rest">🔀 Shuffle Order</button>` : '';
            const loopBtn = items.length ? `<button type="button" class="audioflix-play-group-btn${amq.loop ? ' is-active' : ''}" data-af-action="loop-music-group" title="When the last track ends, loop back to #1">🔁 ${amq.loop ? 'Loop On' : 'Activate Loop'}</button>` : '';
            const queueViewBtn = items.length ? `<button type="button" class="audioflix-play-group-btn" data-af-action="open-queue-view" title="Open this group's queue inside EveOS">🖥 Queue View</button>` : '';
            return `${scopePills}${selector}${smartSelector}${classifierRow}<div class="audioflix-frontend-subhead" style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:12px; padding:0 4px;"><div style="display:flex; align-items:center; gap:10px;"><strong style="font-size:1.05rem; color:#f8fafc;">${esc(displayName)}</strong> <span style="font-size:0.8rem; color:#94a3b8; font-weight:600;">(${items.length} track${items.length === 1 ? '' : 's'})</span></div><div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">${playGroupBtn}${shuffleBtn}${loopBtn}${queueViewBtn}</div></div><div class="audioflix-item-grid" data-af-active-group="${esc(name)}">${items.map((it) => renderItemCard(it, 'music')).join('')}</div>`;
        };

        function renderItems(items, type) {
            if (!items.length) return `<div class="audioflix-empty">No ${type === 'music' ? 'tracks' : 'sounds'} yet.</div>`;
            const isF = (type === 'music' ? (state().musicViewMode || 'backend') : (state().soundboardViewMode || 'backend')) === 'frontend';
            const filtered = type === 'sound' && isF ? items.filter((it) => ctx.isItemExposed(it, 'sound')) : items;
            if (!filtered.length) return `<div class="audioflix-empty">No ${type === 'music' ? 'tracks' : 'exposed sounds'} yet.</div>`;
            if (isF) return type === 'music' ? renderFrontendMusicActive() : renderFrontendActive();
            const collapsed = ctx.getCollapsedGroups(), groups = new Map();
            filtered.forEach((it) => { const key = ctx.groupKey(it, type); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(it); });
            return [...groups.entries()].map(([name, members]) => `<section class="audioflix-group ${collapsed[name] ? 'is-collapsed' : ''}" data-af-group="${esc(name)}"><button type="button" class="audioflix-group-title" data-af-action="toggle-group" data-af-group="${esc(name)}" aria-expanded="${collapsed[name] ? 'false' : 'true'}">${esc(name)}<span class="audioflix-group-count">${members.length} item${members.length === 1 ? '' : 's'}</span></button><div class="audioflix-item-grid">${members.map((it) => renderItemCard(it, type)).join('')}</div></section>`).join('');
        }

        return { frontendMusicItems, frontendMusicSmartEntries, frontendGroupEntries, frontendActiveGroup, renderItemCard, renderItems, renderFrontendActive, renderFrontendMusicActive };
    };

    ns.ready = true;
})();
