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
        let generatedCards = 0, renderGeneration = 0, frontendMusicCache = null, frontendProjectionCache = null, frontendFolderCache = null;
        const metric = (method, name, value) => { try { window.EveAudioflixDiagnostics?.[method]?.(name, value); } catch { /* optional telemetry */ } };
        const timed = (name, operation, render = false) => (...args) => {
            const firstCard = generatedCards;
            let finish, failed = false;
            try { finish = window.EveAudioflixDiagnostics?.span?.(name); } catch { /* optional telemetry */ }
            if (render) { renderGeneration += 1; metric('increment', 'ui:render-generations'); }
            try { return operation(...args); }
            catch (error) { failed = true; throw error; }
            finally {
                if (render) { metric('gauge', 'ui:render-generation', renderGeneration); metric('gauge', 'ui:render-cards', generatedCards - firstCard); }
                try { finish?.(failed); } catch { /* optional telemetry */ }
            }
        };
        const frontendKey = (snapshot = state()) => JSON.stringify(['frontend', 'music', snapshot.activeMusicFolderScope || '',
            snapshot.activeFrontendMusicGroup || '', snapshot.activeFrontendMusicArtist || '', snapshot.activeFrontendMusicClassifier || '',
            snapshot.musicGroups || [], snapshot.musicGroupParents || {}, snapshot.musicClassifiers || [],
            filters.get('musicGroups'), filters.get('musicArtists'), filters.get('musicClassifiers')]);
        const backendKey = (name, type) => JSON.stringify(['backend', type, name]);
        const windows = window.EveAudioflixUiWindow?.create({ esc, renderCard: (item, type) => renderItemCard(item, type),
            itemsForKey: key => { const [mode, type, group] = JSON.parse(key);
                return { type, key: mode === 'frontend' ? frontendKey() : key, items: mode === 'frontend' ? frontendActiveGroup(type).items
                    : (state().music || []).filter(item => ctx.groupKey(item, type) === group) }; },
            afterMount: grid => { window.EveAudioflixTransport?.sync?.(grid); window.EveAudioflixLayerVoices?.render?.(grid); } });
        const cards = (items, key, type) => windows?.render(items, key, type) || items.map(item => renderItemCard(item, type)).join('');
        const windowAttrs = (items, key, type) => windows?.attrs(items, key, type) || '';
        const musicRevision = (snapshot, view = window.EveAudioflixLibraryIndex?.get?.(snapshot, 'music')) =>
            view?.contentRevision ?? window.EveAudioflixState?.getRevision?.() ?? -1;

        function frontendMusicItems() {
            const snapshot = state(), source = snapshot.music || [], scope = snapshot.activeMusicFolderScope || '';
            const view = window.EveAudioflixLibraryIndex?.get?.(snapshot, 'music'), revision = musicRevision(snapshot, view), cached = frontendMusicCache;
            if (cached && cached.snapshot === snapshot && cached.source === source && cached.scope === scope && cached.revision === revision) return cached.items;
            const scoped = scope && view ? view.scope('folder', scope) : source;
            const items = scoped.filter(it => ctx.isItemExposed(it, 'music') && (!scope || String(it.folder || it.card || '').trim() === scope));
            frontendMusicCache = { snapshot, source, scope, revision, items };
            return items;
        }

        function frontendMusicFolders() {
            const snapshot = state(), source = snapshot.music || [], registry = snapshot.musicFolders || [];
            const view = window.EveAudioflixLibraryIndex?.get?.(snapshot, 'music'), revision = musicRevision(snapshot, view);
            const registryKey = registry.join('\u0000'), cached = frontendFolderCache;
            if (cached && cached.snapshot === snapshot && cached.source === source && cached.revision === revision && cached.registryKey === registryKey) return cached.items;
            const items = [...new Set([...registry, ...source.map((it) => String(it.folder || it.card || '').trim())].filter(Boolean))];
            frontendFolderCache = { snapshot, source, revision, registryKey, items };
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

        function frontendGroupEntries(type = 'sound', sourceItems) {
            if (type === 'music') {
                const items = sourceItems || frontendMusicItems(), entries = [], groups = ctx.allGroups('music');
                groups.forEach((group) => {
                    const members = window.EveAudioflixGroupTree?.itemsForGroup?.(state(), 'music', group, items)
                        || items.filter((it) => ctx.groupsOf(it.id, 'music').includes(group));
                    if (members.length) entries.push([group, members, null]);
                });
                entries.push(['Ungrouped', groups.length ? items.filter((it) => !ctx.groupsOf(it.id, 'music').length) : items]);
                return entries;
            }
            const items = [...(state().soundboard || []), ...ctx.getPorted()].filter((it) => ctx.isItemExposed(it, 'sound')), entries = [];
            ctx.allGroups('sound').forEach((group) => {
                const members = window.EveAudioflixGroupTree?.itemsForGroup?.(state(), 'sound', group, items)
                    || items.filter((it) => ctx.groupsOf(it.id, 'sound').includes(group));
                if (members.length) entries.push([group, members, null]);
            });
            entries.push(['Ungrouped', items.filter((it) => !ctx.groupsOf(it.id, 'sound').length)]);
            return entries;
        }

        function frontendActiveGroup(type = 'sound') {
            if (type === 'music') {
                const snapshot = state(), view = window.EveAudioflixLibraryIndex?.get?.(snapshot, 'music');
                const revision = musicRevision(snapshot, view), key = frontendKey(snapshot), cached = frontendProjectionCache;
                if (cached && cached.snapshot === snapshot && cached.revision === revision && cached.key === key) return cached.value;
                const baseItems = frontendMusicItems(), entries = frontendGroupEntries(type, baseItems);
                const chosenGroup = entries.find(([name]) => name === (snapshot.activeFrontendMusicGroup || ''));
                const groupCandidates = chosenGroup ? chosenGroup[1] : baseItems;
                const groupItems = filters.subtract(groupCandidates, entries, filters.get('musicGroups'));
                const smart = frontendMusicSmartEntries(groupItems);
                const chosenArtist = smart.find(([artistKey]) => artistKey === (snapshot.activeFrontendMusicArtist || ''));
                const artistCandidates = chosenArtist ? chosenArtist[1] : groupItems;
                const artistItems = filters.subtract(artistCandidates, smart, filters.get('musicArtists'));
                const classifiers = ctx.classifierEntries(artistItems);
                const chosenClassifier = classifiers.find(([classifierKey]) => classifierKey === (snapshot.activeFrontendMusicClassifier || ''));
                const classifierCandidates = chosenClassifier ? chosenClassifier[1] : artistItems;
                const items = filters.subtract(classifierCandidates, classifiers, filters.get('musicClassifiers'));
                const labels = [chosenGroup?.[0] || 'All Groups', chosenArtist?.[2], chosenClassifier?.[2]].filter(Boolean);
                const value = {
                    name: labels.join(' / '), items, entries, smart, classifiers, baseItems,
                    activeGroup: chosenGroup?.[0] || '', activeArtist: chosenArtist?.[0] || '',
                    activeClassifier: chosenClassifier?.[0] || '', displayName: labels.join(' / ')
                };
                frontendProjectionCache = { snapshot, revision, key, value };
                return value;
            }
            const entries = frontendGroupEntries(type);
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

        function buildItemCard(item, type) {
            const isF = (type === 'music' ? (state().musicViewMode || 'backend') : (state().soundboardViewMode || 'backend')) === 'frontend';
            const transport = window.EveAudioflixTransport?.render?.(item, type, esc) || '';
            const rep = ctx.getActiveRepeaters()[item.id], repBadge = rep ? `<span class="audioflix-repeater-badge" title="Repeater active">🔁 Rep</span>` : '';
            const keyBadge = isF && type === 'sound' && item.hotkey ? `<span class="audioflix-hotkey-badge" title="Hotkey: press ${esc(item.hotkey)}">${esc(item.hotkey)}</span>` : '';
            const delBtn = !isF && !item.isPorted ? `<button type="button" class="audioflix-icon-btn danger" data-af-action="remove" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}">${ctx.closeSvg}</button>` : '';
            const dupLevel = window.EveAudioflixDuplicates?.duplicateLevelFor?.(type, item.id) || '';
            const dupBadge = dupLevel ? `<span class="audioflix-dup-badge${dupLevel === 'soft' ? ' is-soft' : ''}" title="${dupLevel === 'soft' ? 'Possible same-title or clipped version' : 'Matching source identity detected'}">👯 ${dupLevel === 'soft' ? 'Soft dup' : 'Dup'}</span>` : '';
            const showMarkers = state().showPlaylistMarkersOnCard === true;
            const showLocalMissing = state().showLocalMissingMarkersOnCard === true;
            const layerVoices = type === 'sound' ? `<div class="audioflix-layer-voices" data-af-layer-voices="${esc(item.id)}" aria-live="off"></div>` : '';
            const isLibraryOnly = showMarkers && type === 'music' && window.EveAudioflixPlaylists?.isLibraryOnlyTrackInImportedGroup?.(item);
            const localBadge = isLibraryOnly ? `<span class="audioflix-local-badge is-minimized" title="Kept in EveOS; this track is not supplied by the linked playlist" data-af-action="toggle-local-badge"><span class="audioflix-local-badge-icon">⚡</span><span class="audioflix-local-badge-text"> Library-only</span></span>` : '';
            const hasOnlineFallback = type === 'music' && /^https?:\/\//i.test(String(item.url || ''));
            const localOnlyMissing = type === 'music' && item.missingLocal === true && !hasOnlineFallback;
            const localMissingBadge = type === 'music' && item.missingLocal === true && hasOnlineFallback && showLocalMissing
                ? '<span class="audioflix-local-missing-badge" title="The local copy is missing; online fallback may still play">⚠ Local copy missing</span>'
                : '';
            const spotifyUnavailable = type === 'music' && ['unavailable', 'failed'].includes(item.spotifyAvailability)
                ? `<span class="audioflix-provider-unavailable-badge is-compact" tabindex="0" role="img" aria-label="${esc((item.spotifyAvailability === 'unavailable' ? 'Spotify URL unavailable' : 'Spotify playback failed') + ': ' + (item.spotifyAvailabilityReason || 'Open this track to retry.'))}" title="${esc((item.spotifyAvailability === 'unavailable' ? 'Spotify URL unavailable' : 'Spotify playback failed') + ': ' + (item.spotifyAvailabilityReason || 'Open this track to retry.'))}">!</span>` : '';
            const amq = ctx.getActiveMusicQueue();
            let queueBadge = '';
            if (type === 'music' && amq.isPlaying && amq.items.includes(item.id)) {
                const qIdx = amq.items.indexOf(item.id), pos = qIdx + 1;
                const isCurrent = qIdx === amq.currentIndex, isPast = qIdx < amq.currentIndex;
                const statusText = isCurrent ? 'Playing' : isPast ? 'Played' : 'Queued';
                queueBadge = `<span class="audioflix-queue-badge${isCurrent ? ' is-active' : isPast ? ' is-past' : ''}" title="Queue position #${pos} (${statusText})">#${pos} ${statusText}</span>`;
            }
            return `<article class="audioflix-item-card${item.upstreamMissing && showMarkers ? ' is-upstream-missing' : ''}${localOnlyMissing ? ' is-local-missing' : ''}"><div class="audioflix-playback-controls"><button type="button" class="audioflix-stop" data-af-action="stop-item" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="Stop">${ctx.stopSvg}</button><button type="button" class="audioflix-play" data-af-action="play" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="Play">${ctx.playSvg}</button></div><button type="button" class="audioflix-layer-play" data-af-action="layer-play" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="Layer Play">${ctx.layerPlaySvg}</button><div class="audioflix-item-body"><div class="audioflix-item-title-row">${queueBadge}${dupBadge}${localBadge}${localMissingBadge}${spotifyUnavailable}${repBadge}${keyBadge}<strong>${esc(item.title)}</strong></div><span>${esc(ctx.itemMeta(item))}</span>${ctx.groupTags(item, ctx.groupsOf(item.id, type))}</div><div class="audioflix-item-actions">${ctx.internalViewButton(item, type)}${item.upstreamMissing && item.playlistId && showMarkers ? `<button type="button" class="audioflix-icon-btn" data-af-action="keep-playlist-track" data-af-id="${esc(item.id)}" title="Removed from the upstream playlist — keep it in EveOS">&#128190;</button>` : ''}<button type="button" class="audioflix-icon-btn" data-af-action="item-info" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" title="${isF ? 'Settings' : ''}">${ctx.cogSvg}</button>${delBtn}</div>${transport}${layerVoices}</article>`;
        }
        const renderItemCard = timed('ui:render:card', (item, type) => {
            const html = buildItemCard(item, type);
            generatedCards += 1; metric('increment', 'ui:card-generations');
            return html;
        });

        const renderFrontendActive = () => {
            const { name, items, entries, activeGroup } = frontendActiveGroup('sound');
            const exposedCount = [...(state().soundboard || []), ...ctx.getPorted()].filter((it) => ctx.isItemExposed(it, 'sound')).length;
            const all = `<button type="button" class="audioflix-group-pill${activeGroup ? '' : ' is-active'}" data-af-action="select-frontend-group" data-af-type="sound" data-af-group="" title="Clear group include/exclude focus">All Groups<span class="audioflix-group-pill-count">${exposedCount}</span></button>`;
            const exposed = [...(state().soundboard || []), ...ctx.getPorted()].filter((item) => ctx.isItemExposed(item, 'sound'));
            const treeEntries = window.EveAudioflixGroupTree?.entries?.(state(), 'sound', exposed)
                .filter((entry) => entry.members.length).concat(entries.filter(([group]) => group === 'Ungrouped').map(([group, members]) => ({ name: group, members, path: [group], depth: 0 }))) || [];
            const pills = window.EveAudioflixGroupTreeUi?.renderSelector?.({ type: 'sound', entries: treeEntries, active: activeGroup, esc, bucket: 'soundGroups', filters, state: state() }) || '';
            return `<div class="audioflix-group-selector"><span class="audioflix-scope-label">Group:</span>${all}${pills}</div><div class="audioflix-item-grid" data-af-active-group="${esc(name)}">${items.map((it) => renderItemCard(it, 'sound')).join('')}</div>${items.some((it) => it.hotkey) ? '<div class="audioflix-hotkey-hint">Custom hotkeys are active system-wide.</div>' : ''}`;
        };

        function queueControlMarkup(name, count) {
            const amq = ctx.getActiveMusicQueue(), isQueuePlaying = amq.isPlaying && amq.groupName === name;
            const playGroupBtn = count ? (isQueuePlaying ? `<button type="button" class="audioflix-play-group-btn is-active" data-af-action="stop-music-group">⏹ Stop Group</button>` : `<button type="button" class="audioflix-play-group-btn" data-af-action="play-music-group">▶ Play Group</button>`) : '';
            const shuffleBtn = count ? `<button type="button" class="audioflix-play-group-btn${amq.shuffle ? ' is-active' : ''}" data-af-action="shuffle-music-group" title="Make the current track #1 and shuffle the rest">🔀 Shuffle Order</button>` : '';
            const loopBtn = count ? `<button type="button" class="audioflix-play-group-btn${amq.loop ? ' is-active' : ''}" data-af-action="loop-music-group" title="When the last track ends, loop back to #1">🔁 ${amq.loop ? 'Loop On' : 'Activate Loop'}</button>` : '';
            const queueViewBtn = count ? `<button type="button" class="audioflix-play-group-btn" data-af-action="open-queue-view" title="Open this group's queue inside EveOS">🖥 Queue View</button>` : '';
            return playGroupBtn + shuffleBtn + loopBtn + queueViewBtn;
        }

        function syncQueueControls(root) {
            const controls = root.querySelector('[data-af-queue-controls]'), q = ctx.getActiveMusicQueue();
            if (controls) window.EveAudioflixUiPanel.syncButtons(controls, queueControlMarkup(controls.dataset.afQueueName, Number(controls.dataset.afQueueCount)));
            const positions = new Map((q.items || []).map((id, index) => [String(id), index]));
            root.querySelectorAll('.audioflix-item-card').forEach(card => {
                const id = card.querySelector('[data-af-action="play"][data-af-type="music"]')?.dataset.afId;
                const index = q.isPlaying ? positions.get(id) : undefined, row = card.querySelector('.audioflix-item-title-row');
                let badge = row?.querySelector('.audioflix-queue-badge');
                if (index === undefined) { badge?.remove(); return; }
                if (!badge && row) { badge = document.createElement('span'); row.prepend(badge); }
                if (!badge) return;
                const status = index === q.currentIndex ? 'Playing' : index < q.currentIndex ? 'Played' : 'Queued';
                const text = `#${index + 1} ${status}`, title = `Queue position #${index + 1} (${status})`;
                const className = `audioflix-queue-badge${index === q.currentIndex ? ' is-active' : index < q.currentIndex ? ' is-past' : ''}`;
                if (badge.className !== className) badge.className = className;
                if (badge.textContent !== text) badge.textContent = text;
                if (badge.title !== title) badge.title = title;
            });
        }

        const renderFrontendMusicActive = () => {
            const { name, items, entries, smart, classifiers, baseItems, activeGroup, activeArtist, activeClassifier, displayName } = frontendActiveGroup('music');
            const allFolders = frontendMusicFolders(), activeScope = state().activeMusicFolderScope || '';
            const classifierRow = ctx.renderClassifierRow ? ctx.renderClassifierRow(activeClassifier, classifiers) : '';
            const scopePills = `<div class="audioflix-folder-scope-selector"><span class="audioflix-scope-label">Track Focus:</span><button type="button" class="audioflix-scope-pill${activeScope === '' ? ' is-active' : ''}" data-af-action="select-folder-scope" data-af-scope="">🌐 All Folders (No Focus)</button>${allFolders.map((folder) => `<button type="button" class="audioflix-scope-pill${activeScope === folder ? ' is-active' : ''}" data-af-action="select-folder-scope" data-af-scope="${esc(folder)}">📁 ${esc(folder)}</button>`).join('')}</div>`;
            const allGroupPill = `<button type="button" class="audioflix-group-pill${activeGroup === '' ? ' is-active' : ''}" data-af-action="select-frontend-group" data-af-dimension="group" data-af-type="music" data-af-group="" title="Clear group include/exclude focus">All Groups (No Focus)<span class="audioflix-group-pill-count">${baseItems.length}</span></button>`;
            const membersByGroup = new Map(entries.slice(0, -1).map(([group, members]) => [group, members]));
            const treeEntries = window.EveAudioflixGroupTree?.ordered?.(state(), 'music').map(entry => ({ ...entry, members: membersByGroup.get(entry.name) || [] }))
                .filter((entry) => entry.members.length).concat(entries.filter(([group]) => group === 'Ungrouped').map(([group, members]) => ({ name: group, members, path: [group], depth: 0 }))) || [];
            const groupTree = window.EveAudioflixGroupTreeUi?.renderSelector?.({ type: 'music', entries: treeEntries, active: activeGroup, esc, bucket: 'musicGroups', filters, state: state() }) || '';
            const selector = `<div class="audioflix-group-selector"><span class="audioflix-scope-label">Group:</span>${allGroupPill}${groupTree}</div>`;
            const smartOpen = ctx.smartArtistExpanded;
            const smartPills = smart?.length && smartOpen ? smart.map(([key, members, label]) => `<button type="button" class="audioflix-group-pill${filters.pillClass(key, activeArtist, 'musicArtists')}" data-af-action="select-frontend-group" data-af-dimension="artist" data-af-type="music" data-af-group="${esc(key)}" title="${filters.pillTitle(key, activeArtist, 'musicArtists')}">${esc(label)}<span class="audioflix-group-pill-count">${members.length}</span></button>`).join('') : '';
            const smartToggleBtn = smart?.length ? `<button type="button" class="audioflix-add-toggle${smartOpen ? ' is-active' : ''}" data-af-action="toggle-smart-artists" style="font-size:0.75rem; padding:3px 10px; border-radius:12px; cursor:pointer;" title="Toggle artist smart filters">🎤 Artists (${smart.length}) ${smartOpen ? '▲' : '▼'}</button>` : '';
            const smartSelector = smart?.length ? `<div class="audioflix-group-selector audioflix-smart-selector" style="align-items:center; gap:8px;"><span class="audioflix-scope-label">Smart:</span>${smartToggleBtn}${smartPills}</div>` : '';
            const key = frontendKey();
            return `${scopePills}${selector}${smartSelector}${classifierRow}<div class="audioflix-frontend-subhead" style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:12px; padding:0 4px;"><div style="display:flex; align-items:center; gap:10px;"><strong style="font-size:1.05rem; color:#f8fafc;">${esc(displayName)}</strong> <span style="font-size:0.8rem; color:#94a3b8; font-weight:600;">(${items.length} track${items.length === 1 ? '' : 's'})</span></div><div data-af-queue-controls data-af-queue-name="${esc(name)}" data-af-queue-count="${items.length}" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">${queueControlMarkup(name, items.length)}</div></div><div class="audioflix-item-grid" data-af-active-group="${esc(name)}"${windowAttrs(items, key, 'music')}>${cards(items, key, 'music')}</div>`;
        };

        function renderItems(items, type) {
            if (!items.length) return `<div class="audioflix-empty">No ${type === 'music' ? 'tracks' : 'sounds'} yet.</div>`;
            const isF = (type === 'music' ? (state().musicViewMode || 'backend') : (state().soundboardViewMode || 'backend')) === 'frontend';
            const filtered = type === 'sound' && isF ? items.filter((it) => ctx.isItemExposed(it, 'sound')) : items;
            if (!filtered.length) return `<div class="audioflix-empty">No ${type === 'music' ? 'tracks' : 'exposed sounds'} yet.</div>`;
            if (isF) return type === 'music' ? renderFrontendMusicActive() : renderFrontendActive();
            // Prepare compact music metadata during library boot, even when its groups are
            // collapsed. The first Frontend gesture must not also build the badge baseline.
            if (type === 'music') window.EveAudioflixDuplicates?.duplicateBadgeSummary?.(type);
            const collapsed = ctx.getCollapsedGroups(), groups = new Map();
            filtered.forEach((it) => { const key = ctx.groupKey(it, type); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(it); });
            const storedIds = groups.has('Ungrouped') ? new Set(((type === 'music' ? state().music : state().soundboard) || []).map((item) => item.id)) : null;
            return [...groups.entries()].map(([name, members]) => {
                const isUngrouped = name === 'Ungrouped';
                const clearableCount = isUngrouped ? members.filter((item) => storedIds.has(item.id)).length : 0;
                const menuAttrs = isUngrouped && clearableCount
                    ? ` data-af-context="ungrouped" data-af-type="${esc(type)}" data-af-clear-count="${clearableCount}" title="Right-click to clear Ungrouped"`
                    : ` data-af-type="${esc(type)}"`;
                const key = backendKey(name, type);
                return `<section class="audioflix-group ${collapsed[name] ? 'is-collapsed' : ''}" data-af-group="${esc(name)}"><button type="button" class="audioflix-group-title${isUngrouped && clearableCount ? ' has-context-menu' : ''}" data-af-action="toggle-group" data-af-group="${esc(name)}"${menuAttrs} aria-expanded="${collapsed[name] ? 'false' : 'true'}">${esc(name)}<span class="audioflix-group-count">${members.length} item${members.length === 1 ? '' : 's'}</span></button><div class="audioflix-item-grid"${windowAttrs(members, key, type)}>${collapsed[name] ? '' : cards(members, key, type)}</div></section>`;
            }).join('');
        }

        function toggleGroup(button, collapsed) {
            const section = button?.closest?.('.audioflix-group'), grid = section?.querySelector('.audioflix-item-grid');
            if (!section || !grid) return false;
            // Only mount the requested group. Playback lives outside its disposable card UI.
            if (collapsed && grid.contains(document.activeElement)) button.focus({ preventScroll: true });
            section.classList.toggle('is-collapsed', collapsed);
            button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            if (collapsed) grid.replaceChildren();
            else {
                const type = button.dataset.afType === 'music' ? 'music' : 'sound', snapshot = state();
                const items = type === 'music' ? (snapshot.music || []) : [...(snapshot.soundboard || []), ...ctx.getPorted()];
                const group = button.dataset.afGroup, view = type === 'music' ? window.EveAudioflixLibraryIndex?.get?.(snapshot, 'music') : null;
                const members = view ? view.scope('folder', group === 'Ungrouped' ? '' : group) : items.filter(item => ctx.groupKey(item, type) === group);
                const key = backendKey(group, type);
                windows?.configure(grid, members, key, type);
                grid.innerHTML = cards(members, key, type);
                window.EveAudioflixTransport?.sync?.(section);
                window.EveAudioflixLayerVoices?.render?.(section);
            }
            return true;
        }

        function revealCard(id, type = 'music') {
            const root = document.getElementById('audioflix-overlay');
            if (!root || root.hidden) return null;
            const cardFor = () => [...root.querySelectorAll('.audioflix-item-card')].find(card => {
                const play = card.querySelector('[data-af-action="play"]');
                return play?.dataset.afId === String(id) && play.dataset.afType === type;
            });
            let card = cardFor();
            if (card && !card.closest('.audioflix-group.is-collapsed')) return card;
            if (type === 'music' && state().musicViewMode === 'frontend') {
                const scope = frontendActiveGroup('music'), index = scope.items.findIndex(item => String(item.id) === String(id));
                const grid = root.querySelector('.audioflix-item-grid[data-af-active-group]');
                windows?.showIndex(grid, scope.items, frontendKey(), type, index);
                if (index >= 0) return cardFor();
            }
            const items = type === 'music' ? (state().music || []) : [...(state().soundboard || []), ...ctx.getPorted()];
            const item = items.find(entry => String(entry.id) === String(id));
            if (!item) return null;
            const group = ctx.groupKey(item, type);
            const button = [...root.querySelectorAll('.audioflix-group-title')].find(entry => entry.dataset.afGroup === group && entry.dataset.afType === type);
            // Use the existing action owner so collapse state and the mounted projection agree.
            if (button?.getAttribute('aria-expanded') === 'false') button.click();
            const members = items.filter(entry => ctx.groupKey(entry, type) === group);
            windows?.showIndex(button?.closest('.audioflix-group')?.querySelector('.audioflix-item-grid'),
                members, backendKey(group, type), type, members.findIndex(entry => String(entry.id) === String(id)));
            return cardFor();
        }

        return { frontendMusicItems, frontendMusicSmartEntries, frontendGroupEntries, frontendActiveGroup, renderItemCard,
            renderItems: timed('ui:render:items', renderItems, true),
            renderFrontendActive: timed('ui:render:sound-frontend', renderFrontendActive, true),
            renderFrontendMusicActive: timed('ui:render:music-frontend', renderFrontendMusicActive, true),
            toggleGroup: timed('ui:render:group-toggle', toggleGroup, true), revealCard, syncQueueControls };
    };

    ns.ready = true;
})();
