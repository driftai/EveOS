// Live playlist connections for the Audioflix music library.
//
// An imported playlist becomes a music GROUP whose tracks live in a folder (default
// "Youtube Playlists"). The connection stays live: re-syncing re-reads the upstream playlist and
// reconciles. A track removed upstream is NEVER auto-deleted — it is flagged so the UI can grey
// it out, leaving the choice to remove it from EveOS or move it somewhere else to keep.
//
// Listing the upstream playlist needs the EveOS server (a file:// page cannot read youtube.com
// directly — CORS). The imported tracks and connection settings live in the datapack, so they
// show, play, back up and restore everywhere; only SYNC asks for localhost.
window.EveAudioflixPlaylists = window.EveAudioflixPlaylists || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixPlaylists;
    if (ns.ready) return;

    const DEFAULT_FOLDER = 'Youtube Playlists';
    const DEFAULT_SPOTIFY_FOLDER = 'Spotify Playlists';
    const DEFAULT_INSTAGRAM_FOLDER = 'IG Reel Playlists';

    const text = (value, fallback = '') => String(value ?? '').trim().replace(/^["']+|["']+$/g, '').trim() || fallback;
    const sameName = (left, right) => text(left).toLowerCase() === text(right).toLowerCase();
    const providers = () => window.EveAudioflixPlaylistProviders;

    function state() {
        return window.EveAudioflixState?.ensure?.() || {};
    }

    function newId() {
        return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // Pure reconciliation between the tracks EveOS already has for a connection and what the
    // upstream playlist currently contains. Exported so the rules are testable without a browser.
    //   add     — upstream entries with no local track yet
    //   restore — local tracks previously flagged missing that are back upstream
    //   missing — local tracks no longer upstream (grey out; never auto-delete)
    //   keep    — unchanged
    function diffPlaylist(localTracks, upstreamEntries) {
        const locals = Array.isArray(localTracks) ? localTracks : [];
        const upstream = Array.isArray(upstreamEntries) ? upstreamEntries : [];
        const upstreamById = new Map();
        upstream.forEach((entry) => {
            const sourceId = text(entry?.sourceId);
            if (sourceId && !upstreamById.has(sourceId)) upstreamById.set(sourceId, entry);
        });
        const localById = new Map();
        locals.forEach((track) => {
            const sourceId = text(track?.sourceId);
            if (sourceId && !localById.has(sourceId)) localById.set(sourceId, track);
        });

        const add = [];
        upstreamById.forEach((entry, sourceId) => {
            if (!localById.has(sourceId)) add.push(entry);
        });

        const restore = [];
        const missing = [];
        const keep = [];
        localById.forEach((track, sourceId) => {
            if (upstreamById.has(sourceId)) {
                if (track.upstreamMissing) restore.push(track);
                else keep.push(track);
            } else {
                // Already flagged stays flagged — don't report it as a fresh removal every sync.
                if (!track.upstreamMissing) missing.push(track);
            }
        });
        return { add, restore, missing, keep };
    }

    function connections() {
        return (state().musicPlaylists || []).slice();
    }

    function getConnection(connectionId) {
        return connections().find((entry) => entry.id === connectionId) || null;
    }

    function tracksFor(connectionId) {
        return (state().music || []).filter((track) => track.playlistId === connectionId);
    }

    function saveConnections(next, reason) {
        window.EveAudioflixState?.update?.({ musicPlaylists: next }, reason || 'audioflix-music-playlists');
    }

    // Add one upstream entry as a music track bound to this connection.
    function addTrack(connection, entry, targetFolder = '') {
        const patch = providers()?.entryPatch?.(connection.provider, entry) || {};
        const dur = Number(patch.duration !== undefined ? patch.duration : (entry?.duration || 0)) || 0;
        const folderName = text(targetFolder) || text(connection.folder, DEFAULT_FOLDER);
        const title = text(patch.title || entry?.title, 'Untitled Track');
        const artist = text(patch.artist || entry?.artist);
        const added = window.EveAudioflixState?.addItem?.('music', {
            title,
            url: text(entry?.url),
            artist,
            folder: folderName,
            duration: dur,
            ...patch
        });
        if (!added) return null;
        window.EveAudioflixState?.updateItem?.('music', added.id, {
            sourceId: text(entry?.sourceId),
            playlistId: connection.id,
            duration: dur,
            upstreamMissing: false,
            ...patch
        });
        if (connection.group) window.EveAudioflixState?.toggleMusicGroup?.(added.id, connection.group, true);
        return added;
    }

    function applyDiff(connection, diff, targetFolder = '') {
        diff.add.forEach((entry) => addTrack(connection, entry, targetFolder));
        diff.restore.forEach((track) => window.EveAudioflixState?.updateItem?.('music', track.id, { upstreamMissing: false }));
        // Greyed, not gone: the user decides whether to drop it or move it somewhere to keep.
        diff.missing.forEach((track) => window.EveAudioflixState?.updateItem?.('music', track.id, { upstreamMissing: true }));
    }

    function ensurePlacement(connection, targetFolder = '') {
        const folder = text(targetFolder) || text(connection.folder);
        const group = text(connection.group);
        if (group) window.EveAudioflixState?.addMusicGroup?.(group);
        tracksFor(connection.id).forEach((track) => {
            if (folder && !sameName(track.folder, folder)) {
                window.EveAudioflixState?.updateItem?.('music', track.id, { folder });
            }
            if (group) window.EveAudioflixState?.toggleMusicGroup?.(track.id, group, true);
        });
    }

    function refreshProviderMetadata(connection, upstreamEntries) {
        const upstream = new Map((upstreamEntries || []).map((entry) => [text(entry?.sourceId), entry]));
        tracksFor(connection.id).forEach((track) => {
            const entry = upstream.get(text(track.sourceId));
            if (!entry) return;
            const patch = providers()?.entryPatch?.(connection.provider, entry) || {};
            if (Object.keys(patch).length) window.EveAudioflixState?.updateItem?.('music', track.id, patch);
        });
    }

    function reconcileBatch(connection, upstreamEntries, targetFolder, nextConnections, reason) {
        const entries = Array.isArray(upstreamEntries) ? upstreamEntries : [];
        const diff = diffPlaylist(tracksFor(connection.id), entries);
        const bulk = window.EveAudioflixBulk;
        if (!bulk?.replaceMusic) {
            saveConnections(nextConnections, reason);
            applyDiff(connection, diff, targetFolder);
            ensurePlacement(connection, targetFolder);
            refreshProviderMetadata(connection, entries);
            return diff;
        }

        const snapshot = state();
        const folder = text(targetFolder) || text(connection.folder);
        const group = text(connection.group);
        const upstream = new Map(entries.map((entry) => [text(entry?.sourceId), entry]));
        const missingIds = new Set(diff.missing.map((track) => track.id));
        const groupMap = { ...(snapshot.musicGroupMap || {}) };
        const music = (snapshot.music || []).map((track) => {
            if (track.playlistId !== connection.id) return track;
            const entry = upstream.get(text(track.sourceId));
            const patch = entry ? (providers()?.entryPatch?.(connection.provider, entry) || {}) : {};
            const next = Object.assign({}, track, patch, {
                upstreamMissing: entry ? false : missingIds.has(track.id) || track.upstreamMissing,
                ...(folder ? { folder } : {})
            });
            if (group) groupMap[track.id] = [...new Set([...(groupMap[track.id] || []), group])];
            return next;
        });
        diff.add.forEach((entry) => {
            const patch = providers()?.entryPatch?.(connection.provider, entry) || {};
            const duration = Number(patch.duration !== undefined ? patch.duration : (entry?.duration || 0)) || 0;
            const id = window.EveAudioflixStateSchema?.id?.('music') || `music_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            music.push({ id, type: 'music', title: text(patch.title || entry?.title, 'Untitled Track'), url: text(entry?.url), artist: text(patch.artist || entry?.artist), folder, duration, ...patch, sourceId: text(entry?.sourceId), playlistId: connection.id, upstreamMissing: false });
            if (group) groupMap[id] = [...new Set([...(groupMap[id] || []), group])];
        });
        const musicGroups = [...new Set([...(snapshot.musicGroups || []), ...(group ? [group] : [])])];
        const result = bulk.replaceMusic(music, { musicPlaylists: nextConnections, musicGroupMap: groupMap, musicGroups }, reason);
        if (!result?.ok) throw new Error(result?.reason || 'Audioflix could not apply the playlist batch.');
        return diff;
    }

    async function fetchUpstream(url, force, provider = 'youtube', options = {}) {
        const payload = await providers()?.fetchPlaylist?.(provider, url, force, options);
        if (!payload || payload.ok !== true) {
            const reason = payload?.reason || payload?.message
                || 'Playlist sync needs the EveOS server (a file:// page cannot read the playlist directly). Start start-server.bat and open EveOS on localhost.';
            return { ok: false, reason };
        }
        return payload;
    }

    const DEFAULT_WPL_FOLDER = 'WPL Playlists';

    // WPL connections read a local file instead of a web playlist — that half lives next door.
    const { importWplPlaylist, syncWplPlaylist } = window.EveAudioflixPlaylistsWpl.create({
        text, newId, connections, saveConnections, tracksFor, DEFAULT_WPL_FOLDER
    });

    // Import a playlist URL as a group of tracks. options: { folder, group }
    async function importPlaylist(url, options = {}) {
        let clean = text(url);
        if (!clean) return { ok: false, reason: 'Enter a playlist URL.' };
        const provider = providers()?.detect?.(clean) || 'youtube';
        const normalized = providers()?.normalize?.(provider, clean);
        if (!normalized?.ok) return normalized;
        clean = normalized.url;
        const existing = connections().find((entry) => entry.provider === provider && entry.url === clean);
        if (existing) return syncPlaylist(existing.id, true, options.folder);

        const upstream = await fetchUpstream(clean, true, provider, { title: options.group });
        if (!upstream.ok) return upstream;

        const defaultFolder = provider === 'spotify' ? DEFAULT_SPOTIFY_FOLDER
            : provider === 'instagram' ? DEFAULT_INSTAGRAM_FOLDER : DEFAULT_FOLDER;
        const connection = {
            id: newId(),
            url: clean,
            playlistId: text(upstream.playlistId),
            title: text(upstream.title, 'Playlist'),
            provider,
            group: text(options.group, text(upstream.title, 'Playlist')),
            folder: text(options.folder, defaultFolder),
            lastSyncedAt: Date.now(),
            trackCount: (upstream.entries || []).length,
            ...providers()?.connectionPatch?.(provider, { ...upstream, ...normalized })
        };
        const diff = reconcileBatch(connection, upstream.entries || [], options.folder,
            connections().concat(connection), 'audioflix-playlist-import');
        return { ok: true, connection, added: diff.add.length, missing: 0 };
    }

    // Re-read the upstream playlist and reconcile against what EveOS holds.
    async function syncPlaylist(connectionId, force = true, targetFolder = '') {
        const connection = getConnection(connectionId);
        if (!connection) return { ok: false, reason: 'That playlist connection no longer exists.' };
        // A .wpl is a file on disk, not a web playlist — sending its path to the URL lister only
        // ever failed, so route it back through the WPL reader.
        if (connection.provider === 'wpl') return syncWplPlaylist(connection, targetFolder);
        const upstream = await fetchUpstream(connection.url, force, connection.provider, { title: connection.title });
        if (!upstream.ok) return upstream;

        const folderToUse = text(targetFolder) || connection.folder;
        const nextTitle = text(upstream.title, connection.title);
        const followsPlaylistTitle = !connection.group || sameName(connection.group, connection.title);
        const nextGroup = followsPlaylistTitle ? nextTitle : connection.group;
        if (nextGroup && connection.group && !sameName(nextGroup, connection.group)) {
            window.EveAudioflixState?.renameGroup?.('music', connection.group, nextGroup);
        }
        const syncedConnection = { ...connection, title: nextTitle, group: nextGroup, folder: folderToUse };
        const next = connections().map((entry) => entry.id === connection.id
            ? Object.assign({}, entry, {
                title: nextTitle,
                group: nextGroup,
                playlistId: text(upstream.playlistId, entry.playlistId),
                folder: folderToUse,
                lastSyncedAt: Date.now(),
                trackCount: (upstream.entries || []).length,
                ...providers()?.connectionPatch?.(connection.provider, upstream)
            })
            : entry);
        const diff = reconcileBatch(syncedConnection, upstream.entries || [], folderToUse,
            next, 'audioflix-playlist-sync');
        return { ok: true, connection: syncedConnection, added: diff.add.length, restored: diff.restore.length, missing: diff.missing.length };
    }

    // Move a track OUT of the playlist connection but keep it in EveOS (its own folder/group).
    // Used on a greyed track the user wants to hold onto after it left the upstream playlist.
    function detachTrack(trackId, target = {}) {
        if (!trackId) return false;
        const patch = { playlistId: '', upstreamMissing: false };
        if (target.folder !== undefined) patch.folder = text(target.folder);
        window.EveAudioflixState?.updateItem?.('music', trackId, patch);
        if (target.group) window.EveAudioflixState?.toggleMusicGroup?.(trackId, text(target.group), true);
        return true;
    }

    function removeTrack(trackId) {
        if (!trackId) return false;
        window.EveAudioflixState?.removeItem?.('music', trackId);
        return true;
    }

    // Edit where an imported playlist stores its tracks (folder/group), moving existing ones.
    function updateConnection(connectionId, patch = {}) {
        const connection = getConnection(connectionId);
        if (!connection) return false;
        const nextFolder = patch.folder !== undefined ? text(patch.folder, DEFAULT_FOLDER) : connection.folder;
        const nextGroup = patch.group !== undefined ? text(patch.group) : connection.group;
        const tracks = tracksFor(connection.id);
        if (nextFolder !== connection.folder) {
            tracks.forEach((track) => window.EveAudioflixState?.updateItem?.('music', track.id, { folder: nextFolder }));
        }
        if (nextGroup !== connection.group) {
            if (nextGroup) window.EveAudioflixState?.addMusicGroup?.(nextGroup);
            tracks.forEach((track) => {
                if (connection.group) window.EveAudioflixState?.toggleMusicGroup?.(track.id, connection.group, false);
                if (nextGroup) window.EveAudioflixState?.toggleMusicGroup?.(track.id, nextGroup, true);
            });
        }
        saveConnections(connections().map((entry) => entry.id === connection.id
            ? Object.assign({}, entry, { folder: nextFolder, group: nextGroup })
            : entry), 'audioflix-playlist-settings');
        return true;
    }

    // Drop the connection. Tracks are kept by default (just unlinked) so a disconnect never
    // silently deletes a library; pass { removeTracks: true } to clear them out too.
    function removeConnection(connectionId, options = {}) {
        const connection = getConnection(connectionId);
        if (!connection) return false;
        tracksFor(connection.id).forEach((track) => {
            if (options.removeTracks) removeTrack(track.id);
            else window.EveAudioflixState?.updateItem?.('music', track.id, { playlistId: '', upstreamMissing: false });
        });
        saveConnections(connections().filter((entry) => entry.id !== connection.id), 'audioflix-playlist-remove');
        return true;
    }

    // Get connection matching a specific group name
    function getPlaylistForGroup(groupName) {
        const clean = text(groupName);
        if (!clean) return null;
        return connections().find((entry) => text(entry.group) === clean || text(entry.title) === clean) || null;
    }

    // Repoint an imported playlist at a corrected source. Browsers never hand out a directory
    // when you pick a file, and a .wpl or playlist URL can move, so the saved link has to be
    // fixable by hand — otherwise a stale link leaves the connection permanently unsyncable.
    function setPlaylistLink(groupName, link) {
        const conn = getPlaylistForGroup(groupName);
        if (!conn) return { ok: false, reason: `No live playlist connection found for group "${groupName}".` };
        let clean = text(link);
        if (!clean) return { ok: false, reason: 'Enter a playlist URL or .wpl file path.' };
        const normalized = providers()?.normalize?.(conn.provider, clean);
        if (!normalized?.ok) return normalized;
        clean = normalized.url;
        if (clean === text(conn.url)) return { ok: true, connection: conn, unchanged: true };
        const providerPatch = providers()?.connectionPatch?.(conn.provider, normalized) || {};
        saveConnections(connections().map((entry) => entry.id === conn.id
            ? Object.assign({}, entry, { url: clean }, providerPatch)
            : entry), 'audioflix-playlist-link');
        return { ok: true, connection: { ...conn, url: clean } };
    }

    // Sync a single playlist by its group name
    async function syncPlaylistByGroup(groupName, force = true, targetFolder = '') {
        const conn = getPlaylistForGroup(groupName);
        if (!conn) return { ok: false, reason: `No live playlist connection found for group "${groupName}".` };
        return syncPlaylist(conn.id, force, targetFolder);
    }

    // A library-only item remains in an imported group but is not supplied by that playlist.
    // This is provenance, not proof that the media has a localized/offline file.
    function isLibraryOnlyTrackInImportedGroup(item) {
        if (!item || !item.id) return false;
        const groups = window.EveAudioflixState?.ensure?.()?.musicGroupMap?.[item.id] || [];
        if (!groups.length) return false;
        const importedConn = connections().find(c => groups.includes(c.group));
        if (!importedConn) return false;
        return !item.sourceId || item.playlistId !== importedConn.id;
    }

    Object.assign(ns, {
        ready: true,
        DEFAULT_FOLDER,
        DEFAULT_SPOTIFY_FOLDER,
        DEFAULT_INSTAGRAM_FOLDER,
        DEFAULT_WPL_FOLDER,
        diffPlaylist,
        connections,
        getConnection,
        getPlaylistForGroup,
        setPlaylistLink,
        syncPlaylistByGroup,
        isLibraryOnlyTrackInImportedGroup,
        isLocalTrackInImportedGroup: isLibraryOnlyTrackInImportedGroup,
        tracksFor,
        importPlaylist,
        importWplPlaylist,
        syncPlaylist,
        detachTrack,
        removeTrack,
        updateConnection,
        removeConnection
    });
})();
