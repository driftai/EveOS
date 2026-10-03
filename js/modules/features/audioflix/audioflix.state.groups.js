// Group + folder organization operations for Audioflix state. Split out of audioflix.state.js
// to keep that store under the project line cap. These are the many-to-many membership editors
// (a sound/track can sit in several groups), the music-folder rename/delete helpers, and the
// generic item patcher. They mutate the live state object in place, so the host store passes in
// its own primitives (`ensure` returns the live state, `text` coerces, `scheduleSave` persists);
// every function returns ensure() so callers get the fresh snapshot exactly as before.
window.EveAudioflixStateGroups = window.EveAudioflixStateGroups || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixStateGroups;
    if (ns.ready) return;

    ns.create = function create(deps) {
        const ensure = deps.ensure;
        const text = deps.text;
        const scheduleSave = deps.scheduleSave;
        const syncRootOrFallback = deps.syncRootOrFallback || (() => {});
        const tree = window.EveAudioflixGroupTree;
        const sameName = (a, b) => text(a, '').trim().toLowerCase() === text(b, '').trim().toLowerCase();
        const uniqueNames = (values) => {
            const seen = new Set();
            return (values || []).filter((value) => {
                const key = text(value, '').trim().toLowerCase();
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        };
        const migrateScopeDir = (state, scope, oldName, newName = '') => {
            const wanted = `${scope}:${oldName}`.toLowerCase();
            const target = newName ? `${scope}:${newName}` : '';
            let movedValue = '';
            const next = {};
            Object.entries(state.localizeScopeDirs || {}).forEach(([key, value]) => {
                if (text(key, '').toLowerCase() === wanted) movedValue ||= value;
                else next[key] = value;
            });
            if (target && movedValue && !Object.keys(next).some((key) => key.toLowerCase() === target.toLowerCase())) {
                next[target] = movedValue;
            }
            state.localizeScopeDirs = next;
            return movedValue;
        };
        const migrateLocalizationSource = (item, oldSource, newSource) => {
            let changed = false;
            const localizations = (item.localizations || []).map((entry) => {
                if (!sameName(entry.source, oldSource)) return entry;
                changed = true;
                return { ...entry, source: newSource };
            });
            return changed ? { ...item, localizations } : item;
        };

        // --- Custom soundboard groups (many-to-many: a sound can sit in several groups) ---
        function addSoundboardGroup(name, parent = '') {
            const state = ensure();
            const requested = text(name, '').trim();
            const clean = (state.soundboardGroups || []).find((group) => sameName(group, requested)) || requested;
            if (!clean) return ensure();
            state.soundboardGroups = state.soundboardGroups || [];
            if (!state.soundboardGroups.some((group) => sameName(group, clean))) state.soundboardGroups.push(clean);
            state.soundGroupParents = tree?.normalizeParents?.(state.soundboardGroups, {
                ...(state.soundGroupParents || {}), ...(parent ? { [clean]: parent } : {})
            }) || state.soundGroupParents || {};
            syncRootOrFallback(state);
            scheduleSave('audioflix-groups');
            return ensure();
        }

        function removeSoundboardGroup(name) {
            const state = ensure();
            const requested = text(name, '').trim();
            const clean = (state.soundboardGroups || []).find((group) => sameName(group, requested)) || requested;
            const parent = state.soundGroupParents?.[clean] || '';
            state.soundboardGroups = (state.soundboardGroups || []).filter((g) => !sameName(g, clean));
            state.soundGroupParents = Object.fromEntries(Object.entries(state.soundGroupParents || {})
                .filter(([child]) => !sameName(child, clean))
                .map(([child, owner]) => [child, sameName(owner, clean) ? parent : owner]));
            // Strip the group from every sound's membership so we don't leave orphan tags.
            state.soundGroupMap = state.soundGroupMap || {};
            for (const id of Object.keys(state.soundGroupMap)) {
                const next = (state.soundGroupMap[id] || []).filter((g) => !sameName(g, clean));
                if (next.length) state.soundGroupMap[id] = next; else delete state.soundGroupMap[id];
            }
            if (sameName(state.activeFrontendGroup, clean)) state.activeFrontendGroup = '';
            syncRootOrFallback(state);
            scheduleSave('audioflix-groups');
            return ensure();
        }

        function toggleSoundGroup(soundId, name, on) {
            const state = ensure();
            const requested = text(name, '').trim();
            const clean = (state.soundboardGroups || []).find((group) => sameName(group, requested)) || requested;
            if (!soundId || !clean) return ensure();
            state.soundboardGroups = state.soundboardGroups || [];
            if (!state.soundboardGroups.some((group) => sameName(group, clean))) state.soundboardGroups.push(clean);
            state.soundGroupMap = state.soundGroupMap || {};
            const list = state.soundGroupMap[soundId] || [];
            const has = list.some((group) => sameName(group, clean));
            if (on && !has) state.soundGroupMap[soundId] = [...list, clean];
            else if (!on && has) {
                const next = list.filter((g) => !sameName(g, clean));
                if (next.length) state.soundGroupMap[soundId] = next; else delete state.soundGroupMap[soundId];
            }
            syncRootOrFallback(state);
            scheduleSave('audioflix-groups');
            return ensure();
        }

        // --- Custom music groups ---
        function addMusicGroup(name, parent = '') {
            const state = ensure();
            const requested = text(name, '').trim();
            const clean = (state.musicGroups || []).find((group) => sameName(group, requested)) || requested;
            if (!clean) return ensure();
            state.musicGroups = state.musicGroups || [];
            if (!state.musicGroups.some((group) => sameName(group, clean))) state.musicGroups.push(clean);
            state.musicGroupParents = tree?.normalizeParents?.(state.musicGroups, {
                ...(state.musicGroupParents || {}), ...(parent ? { [clean]: parent } : {})
            }) || state.musicGroupParents || {};
            syncRootOrFallback(state);
            scheduleSave('audioflix-music-groups');
            return ensure();
        }

        function removeMusicGroup(name) {
            const state = ensure();
            const clean = text(name, '').trim();
            const parent = state.musicGroupParents?.[clean] || '';
            state.musicGroups = (state.musicGroups || []).filter((g) => !sameName(g, clean));
            state.musicGroupParents = Object.fromEntries(Object.entries(state.musicGroupParents || {})
                .filter(([child]) => !sameName(child, clean))
                .map(([child, owner]) => [child, sameName(owner, clean) ? parent : owner]));
            state.musicGroupMap = state.musicGroupMap || {};
            for (const id of Object.keys(state.musicGroupMap)) {
                const next = (state.musicGroupMap[id] || []).filter((g) => !sameName(g, clean));
                if (next.length) state.musicGroupMap[id] = next; else delete state.musicGroupMap[id];
            }
            if (sameName(state.activeFrontendMusicGroup, clean)) {
                state.activeFrontendMusicGroup = '';
                state.activeFrontendMusicArtist = '';
                state.activeFrontendMusicClassifier = '';
            }
            const oldSource = `group:${clean}`;
            const oldRoot = migrateScopeDir(state, 'group', clean);
            state.music = (state.music || []).map((item) => {
                const next = migrateLocalizationSource(item, oldSource, `manual:${item.id}`);
                if (next !== item && oldRoot) state.localizeScopeDirs[`song:${item.id}`] ||= oldRoot;
                return next;
            });
            syncRootOrFallback(state);
            scheduleSave('audioflix-music-groups');
            return ensure();
        }

        function toggleMusicGroup(musicId, name, on) {
            const state = ensure();
            const requested = text(name, '').trim();
            const clean = (state.musicGroups || []).find((group) => sameName(group, requested)) || requested;
            if (!musicId || !clean) return ensure();
            state.musicGroups = state.musicGroups || [];
            if (!state.musicGroups.some((group) => sameName(group, clean))) state.musicGroups.push(clean);
            state.musicGroupMap = state.musicGroupMap || {};
            const list = state.musicGroupMap[musicId] || [];
            const has = list.some((group) => sameName(group, clean));
            if (on && !has) state.musicGroupMap[musicId] = [...list, clean];
            else if (!on && has) {
                const next = list.filter((g) => !sameName(g, clean));
                if (next.length) state.musicGroupMap[musicId] = next; else delete state.musicGroupMap[musicId];
            }
            syncRootOrFallback(state);
            scheduleSave('audioflix-music-groups');
            return ensure();
        }

        function updateItem(type, itemId, patch) {
            const state = ensure();
            const key = type === 'music' ? 'music' : 'soundboard';
            if (state[key]) {
                state[key] = state[key].map(entry => entry.id === itemId ? Object.assign({}, entry, patch || {}) : entry);
            }
            if (type === 'music') state.musicFolders = window.EveAudioflixStateRecovery?.folderRegistry?.(state) || state.musicFolders || [];
            syncRootOrFallback(state);
            scheduleSave(`audioflix-update-${type}`);
            return ensure();
        }

        function renameMusicFolder(oldFolder, newFolder) {
            const state = ensure();
            const oldClean = text(oldFolder, '').trim();
            const newClean = text(newFolder, '').trim();
            if (!oldClean || !newClean || oldClean === newClean) return ensure();
            const oldSource = `folder:${oldClean}`;
            state.music = (state.music || []).map((entry) => {
                const localized = migrateLocalizationSource(entry, oldSource, `folder:${newClean}`);
                const currentFolder = text(entry.folder || entry.card, '');
                return sameName(currentFolder, oldClean)
                    ? Object.assign({}, localized, { folder: newClean, card: newClean })
                    : localized;
            });
            migrateScopeDir(state, 'folder', oldClean, newClean);
            state.musicFolders = uniqueNames([...(state.musicFolders || []).map((name) => sameName(name, oldClean) ? newClean : name), newClean]);
            state.musicPortConnections = (state.musicPortConnections || []).map((entry) => (
                sameName(entry.folder, oldClean) ? { ...entry, folder: newClean } : entry
            ));
            if (sameName(state.activeMusicFolderScope, oldClean)) state.activeMusicFolderScope = newClean;
            syncRootOrFallback(state);
            scheduleSave('audioflix-rename-folder');
            return ensure();
        }

        function deleteMusicFolder(folderName) {
            const state = ensure();
            const clean = text(folderName, '').trim();
            if (!clean) return ensure();
            const oldSource = `folder:${clean}`;
            const oldRoot = migrateScopeDir(state, 'folder', clean);
            state.music = (state.music || []).map((entry) => {
                const localized = migrateLocalizationSource(entry, oldSource, `manual:${entry.id}`);
                if (localized !== entry && oldRoot) state.localizeScopeDirs[`song:${entry.id}`] ||= oldRoot;
                const currentFolder = text(entry.folder || entry.card, '');
                return sameName(currentFolder, clean)
                    ? Object.assign({}, localized, { folder: '', card: '' })
                    : localized;
            });
            state.musicFolders = (state.musicFolders || []).filter((folder) => !sameName(folder, clean));
            state.musicPortConnections = (state.musicPortConnections || [])
                .filter((entry) => !sameName(entry.folder, clean));
            state.musicFolders = (state.musicFolders || []).filter((name) => !sameName(name, clean));
            if (sameName(state.activeMusicFolderScope, clean)) state.activeMusicFolderScope = '';
            syncRootOrFallback(state);
            scheduleSave('audioflix-delete-folder');
            return ensure();
        }

        function renameGroup(type, oldName, newName) {
            const state = ensure();
            const oldClean = text(oldName, '').trim();
            const newClean = text(newName, '').trim();
            if (!oldClean || !newClean || oldClean === newClean) return ensure();

            const isM = type === 'music';
            const groupsKey = isM ? 'musicGroups' : 'soundboardGroups';
            const mapKey = isM ? 'musicGroupMap' : 'soundGroupMap';
            const activeKey = isM ? 'activeFrontendMusicGroup' : 'activeFrontendGroup';
            const parentsKey = isM ? 'musicGroupParents' : 'soundGroupParents';

            if (Array.isArray(state[groupsKey])) {
                state[groupsKey] = uniqueNames(state[groupsKey].map(g => sameName(g, oldClean) ? newClean : g));
            }

            if (state[mapKey] && typeof state[mapKey] === 'object') {
                Object.keys(state[mapKey]).forEach(itemId => {
                    if (Array.isArray(state[mapKey][itemId])) {
                        state[mapKey][itemId] = uniqueNames(
                            state[mapKey][itemId].map(g => sameName(g, oldClean) ? newClean : g)
                        );
                    }
                });
            }
            state[parentsKey] = Object.fromEntries(Object.entries(state[parentsKey] || {}).map(([child, parent]) => [
                sameName(child, oldClean) ? newClean : child,
                sameName(parent, oldClean) ? newClean : parent
            ]));
            state[parentsKey] = tree?.normalizeParents?.(state[groupsKey], state[parentsKey]) || state[parentsKey];

            if (sameName(state[activeKey], oldClean)) {
                state[activeKey] = newClean;
            }
            if (isM) {
                const oldSource = `group:${oldClean}`;
                state.music = (state.music || []).map((item) => (
                    migrateLocalizationSource(item, oldSource, `group:${newClean}`)
                ));
                migrateScopeDir(state, 'group', oldClean, newClean);
            }

            syncRootOrFallback(state);
            scheduleSave(`audioflix-rename-group-${type}`);
            return ensure();
        }

        function setGroupParent(type, group, parent = '') {
            const state = ensure(), isM = type === 'music';
            const groupsKey = isM ? 'musicGroups' : 'soundboardGroups';
            const parentsKey = isM ? 'musicGroupParents' : 'soundGroupParents';
            const groups = state[groupsKey] || [];
            const clean = groups.find((name) => sameName(name, group)) || text(group, '').trim();
            const nextParent = groups.find((name) => sameName(name, parent)) || text(parent, '').trim();
            const currentParent = state[parentsKey]?.[clean] || '';
            if (!tree?.canParent?.(state, type, clean, nextParent)) {
                return { ok: false, group: clean, parent: currentParent, reason: 'That move would create a group cycle or target a missing group.' };
            }
            const next = { ...(state[parentsKey] || {}) };
            if (nextParent) next[clean] = nextParent; else delete next[clean];
            state[parentsKey] = tree.normalizeParents(state[groupsKey] || [], next);
            syncRootOrFallback(state);
            scheduleSave(`audioflix-group-parent-${type}`);
            return { ok: true, group: clean, parent: state[parentsKey][clean] || '' };
        }

        return {
            addSoundboardGroup,
            removeSoundboardGroup,
            toggleSoundGroup,
            addMusicGroup,
            removeMusicGroup,
            toggleMusicGroup,
            updateItem,
            renameMusicFolder,
            deleteMusicFolder,
            renameGroup,
            setGroupParent
        };
    };

    ns.ready = true;
})();
