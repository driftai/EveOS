// Atomic organization operations for large Audioflix libraries. One pass builds the next track
// and membership state, then one store update persists it. This avoids hundreds of per-track
// normalizations, localStorage writes, and state-change events during a bulk edit.
window.EveAudioflixBulk = window.EveAudioflixBulk || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixBulk;
    if (ns.ready) return;

    const store = () => window.EveAudioflixState;
    const state = () => store()?.ensure?.() || {};
    const text = (value) => String(value ?? '').trim();
    const names = (value) => {
        const list = Array.isArray(value) ? value : [value];
        return [...new Set(list.map(text).filter(Boolean))];
    };

    function canonicalize(registry, requested) {
        const current = Array.isArray(registry) ? registry : [];
        const byLower = new Map(current.map((name) => [text(name).toLowerCase(), text(name)]));
        return names(requested).map((name) => byLower.get(name.toLowerCase()) || name);
    }

    function removeNames(source, requested) {
        const removed = new Set(names(requested).map((name) => name.toLowerCase()));
        return names(source).filter((name) => !removed.has(name.toLowerCase()));
    }

    function sameList(left, right) {
        if (left.length !== right.length) return false;
        return left.every((value, index) => value === right[index]);
    }

    function applyMusicChanges(trackIds, changes) {
        const snapshot = state();
        const validIds = new Set((snapshot.music || []).map((track) => track.id));
        const selected = new Set(names(trackIds).filter((id) => validIds.has(id)));
        if (!selected.size) return { ok: false, changed: 0, selected: 0, reason: 'Select at least one track.' };

        const input = changes && typeof changes === 'object' ? changes : {};
        const addGroups = canonicalize(snapshot.musicGroups, input.addGroups);
        const removeGroups = names(input.removeGroups);
        const addClassifiers = canonicalize(snapshot.musicClassifiers, input.addClassifiers);
        const removeClassifiers = names(input.removeClassifiers);
        const folderAction = ['set', 'clear'].includes(input.folderAction) ? input.folderAction : '';
        const folder = folderAction === 'set' ? text(input.folder) : '';
        if (folderAction === 'set' && !folder) {
            return { ok: false, changed: 0, selected: selected.size, reason: 'Give the destination folder a name.' };
        }

        const groupMap = Object.assign({}, snapshot.musicGroupMap || {});
        let changed = 0;
        const updatedAt = Date.now();
        const music = (snapshot.music || []).map((track) => {
            if (!selected.has(track.id)) return track;
            let next = track;
            let trackChanged = false;

            const currentClassifiers = names(track.classifiers);
            const nextClassifiers = removeNames([...currentClassifiers, ...addClassifiers], removeClassifiers);
            if (!sameList(currentClassifiers, nextClassifiers)) {
                next = Object.assign({}, next, { classifiers: nextClassifiers });
                trackChanged = true;
            }

            if (folderAction) {
                const currentFolder = text(track.folder || track.card);
                if (currentFolder !== folder || text(track.folder) !== folder || text(track.card) !== folder) {
                    next = Object.assign({}, next, { folder, card: folder });
                    trackChanged = true;
                }
            }

            const currentGroups = names(groupMap[track.id]);
            const nextGroups = removeNames([...currentGroups, ...addGroups], removeGroups);
            if (!sameList(currentGroups, nextGroups)) {
                if (nextGroups.length) groupMap[track.id] = nextGroups;
                else delete groupMap[track.id];
                trackChanged = true;
            }

            if (trackChanged) {
                next = Object.assign({}, next, { updatedAt });
                changed += 1;
            }
            return next;
        });

        if (!changed) return { ok: true, changed: 0, selected: selected.size, reason: 'Those tracks already match the requested organization.' };

        const musicGroups = names([...(snapshot.musicGroups || []), ...addGroups]);
        const musicClassifiers = names([...(snapshot.musicClassifiers || []), ...addClassifiers]).slice(0, 200);
        store()?.update?.({
            music,
            musicGroupMap: groupMap,
            musicGroups,
            musicClassifiers
        }, 'audioflix-bulk-organize');
        return { ok: true, changed, selected: selected.size };
    }

    // Replace a prepared music list in one normalized store mutation. Playlist sync uses this
    // instead of add + update + group writes for every row, which became quadratic at scale.
    function replaceMusic(items, patch = {}, reason = 'audioflix-bulk-music') {
        const snapshot = state();
        const schema = window.EveAudioflixStateSchema;
        const cleaner = schema?.create?.({ text: schema.text, normalizeVolume: schema.normalizeVolume, id: schema.id });
        if (!cleaner?.cleanItem || !store()?.update) return { ok: false, reason: 'Audioflix state schema is unavailable.' };
        const music = (Array.isArray(items) ? items : [])
            .map((item) => cleaner.cleanItem(item, 'music'))
            .filter((item) => !!item.url || !!item.localPath)
            .slice(-10000);
        const validIds = new Set(music.map((item) => item.id));
        const sourceMap = patch.musicGroupMap || snapshot.musicGroupMap || {};
        const musicGroupMap = Object.fromEntries(Object.entries(sourceMap)
            .filter(([id, groups]) => validIds.has(id) && names(groups).length)
            .map(([id, groups]) => [id, names(groups)]));
        const next = { ...patch, music, musicGroupMap };
        next.musicFolders = window.EveAudioflixStateRecovery?.folderRegistry?.({ ...snapshot, ...next }) || snapshot.musicFolders || [];
        store().update(next, reason);
        return { ok: true, music, state: state() };
    }

    function musicFolders() {
        return [...new Set((state().music || [])
            .map((track) => text(track.folder || track.card))
            .filter(Boolean))]
            .sort((left, right) => left.localeCompare(right));
    }

    Object.assign(ns, {
        ready: true,
        applyMusicChanges,
        replaceMusic,
        musicFolders
    });
})();
