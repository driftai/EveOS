// Music localization keeps online URLs beside local paths across library/folder/group/song scopes.
window.EveAudioflixLocalize = window.EveAudioflixLocalize || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixLocalize;
    if (ns.ready) return;

    const S = () => window.EveAudioflixState;
    const state = () => S()?.ensure?.() || {};
    const text = (v) => String(v ?? '').trim();
    const isHttp = (u) => /^https?:\/\//i.test(text(u));
    const paths = window.EveAudioflixPaths;
    const sameText = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();
    const scopeDirKey = (scope, key = '') => `${scope}:${key || ''}`;
    const readScopeDir = (scope, key = '') => {
        const wanted = scopeDirKey(scope, key).toLowerCase();
        const match = Object.entries(state().localizeScopeDirs || {})
            .find(([storedKey]) => text(storedKey).toLowerCase() === wanted);
        return text(match?.[1]);
    };
    const normTitle = (v) => paths?.titleKey?.(v)
        || text(v).toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

    const musicItems = () => state().music || [];
    function collectScope(scope, key) {
        const all = musicItems();
        if (scope === 'song') return all.filter((it) => it.id === key);
        if (scope === 'folder') return all.filter((it) => sameText(it.folder || it.card, key));
        if (scope === 'group') {
            const map = state().musicGroupMap || {};
            const names = window.EveAudioflixGroupTree?.membershipNames?.(state(), 'music', key) || [key];
            return all.filter((it) => (map[it.id] || []).some((name) => names.some((group) => sameText(name, group))));
        }
        return all;
    }

    // The subset worth downloading: online tracks lacking a local file (or marked missing on disk).
    // `force` also re-includes tracks that already have a localPath — the relocalize path for when
    // the local copy was deleted or you want a fresh download (the server overwrites).
    function localizeCandidates(scope, key, force = false) {
        return collectScope(scope, key).filter((it) => (isHttp(it.url) || Boolean(it.localPath)) && (force || !text(it.localPath) || it.missingLocal === true));
    }

    // Counts the localize form needs: online tracks in scope, how many are not-yet-local or missing on disk.
    function scopeStats(scope, key) {
        const items = collectScope(scope, key);
        const online = items.filter((it) => isHttp(it.url) || Boolean(it.localPath));
        const missingLocalCount = online.filter((it) => it.missingLocal === true).length;
        const notLocal = online.filter((it) => !text(it.localPath) || it.missingLocal === true).length;
        const alreadyLocal = online.length - notLocal;
        return { online: online.length, notLocal, alreadyLocal, missingLocal: missingLocalCount };
    }

    // Audit local PC disk status for a scope using scanLocalized.
    // The disk audit lives in a sibling module (see it for the shortcut-vs-physical rules).
    const auditScopeDiskStatus = window.EveAudioflixLocalizeAudit.create({
        S, text, paths, collectScope, getScopeDir: (s, k) => getScopeDir(s, k),
        extractDir: (p) => extractDir(p)
    });

    function extractDir(filePath) {
        if (paths?.dirname) return paths.dirname(filePath);
        const p = text(filePath).replace(/\\/g, '/');
        const idx = p.lastIndexOf('/');
        if (idx <= 0) return '';
        return p.substring(0, idx).replace(/\//g, '\\');
    }

    const lastDir = () => text(state().localizeDir);
    const rememberDir = (dir, scope = 'library', key = '') => {
        const clean = text(dir);
        if (!clean) return;
        const canonicalKey = scopeDirKey(scope, key);
        const wanted = canonicalKey.toLowerCase();
        const scopeDirs = Object.fromEntries(Object.entries(state().localizeScopeDirs || {})
            .filter(([storedKey]) => text(storedKey).toLowerCase() !== wanted));
        scopeDirs[canonicalKey] = clean;
        S()?.update?.({ localizeDir: clean, localizeScopeDirs: scopeDirs }, 'audioflix-localize-dir');
    };

    function getScopeDir(scope = 'library', key = '') {
        const savedScopeDir = readScopeDir(scope, key);
        if (savedScopeDir) return savedScopeDir;

        const items = collectScope(scope, key);
        const withLocal = items.find((it) => text(it.localPath));
        if (withLocal) {
            const derived = extractDir(withLocal.localPath);
            if (derived) return derived;
        }
        return lastDir();
    }

    // The scope's OWN directory, with no last-used fallback. getScopeDir's fallback is right for
    // pre-filling the localize form but wrong for display: the Groups/Folders panels rendered it as
    // "📁 <dir>" next to a group, so an unrelated folder (whatever was localized last) looked like
    // that group's established location.
    function getScopeDirOwn(scope = 'library', key = '') {
        const saved = readScopeDir(scope, key);
        if (saved) return saved;
        const withLocal = collectScope(scope, key).find((it) => text(it.localPath));
        return withLocal ? (extractDir(withLocal.localPath) || '') : '';
    }

    // Batch-update target directory for a scope (e.g. folder or group) and migrate localPaths for all member tracks.
    function updateScopeDir(scope, key, newTargetDir) {
        const dir = text(paths?.stripQuotes?.(newTargetDir)).replace(/[/\\]+$/, '')
            || text(newTargetDir).replace(/[/\\]+$/, '');
        if (!dir) return { ok: false, reason: 'Invalid directory path' };

        const connection = scope === 'folder'
            ? (state().musicPortConnections || []).find((entry) => (
                text(entry.folder).toLowerCase() === text(key).toLowerCase()
            ))
            : null;
        // Connected Music Ports are the authoritative fallback for states that predate per-scope
        // path memory. Read this before rememberDir() overwrites the current scope root.
        const previousDir = readScopeDir(scope, key)
            || text(connection?.path)
            || getScopeDirOwn(scope, key);
        rememberDir(dir, scope, key);
        const items = collectScope(scope, key);
        let updatedCount = 0;

        // Recalibrating ONE scope must only move THAT scope's own entry. A song lives physically in a
        // single place (normally its folder file); the other entries are where a shortcut should sit or
        // where a group keeps its own duplicate copy. The old code rewrote localPath/url for every
        // member, so recalibrating a folder stomped the group's paths (and vice versa) — the
        // "EveOS logic overwrote the songs" case. `linkOf` is never rewritten here: a shortcut's
        // physical target belongs to whichever scope really owns the bytes.
        items.forEach((it) => {
            const patch = {};
            const existing = Array.isArray(it.localizations) ? it.localizations : [];
            const scopeSource = scope === 'song' ? sourceForScope(scope, key, it) : `${scope}:${key}`;
            const owns = existing.some((l) => sameText(l.source, scopeSource));
            let next = existing;

            if (owns) {
                next = existing.map((l) => {
                    if (!sameText(l.source, scopeSource) || !text(l.path)) return l;
                    return {
                        ...l,
                        source: scopeSource,
                        path: paths?.rebase?.(l.path, previousDir, dir) || l.path
                    };
                });
            } else if (text(it.localPath)
                && (!previousDir || paths?.relativeTo?.(it.localPath, previousDir) != null)) {
                // Legacy upgrade: a pre-classifier localPath that lived in this scope's old folder
                // becomes a proper entry for this scope, so future recalibrations stay scoped.
                const rebased = paths?.rebase?.(it.localPath, previousDir, dir);
                if (rebased) next = [...existing, { source: scopeSource, path: rebased, kind: 'file', linkOf: '' }];
            }

            if (next !== existing) {
                patch.localizations = next;
                // The effective path is re-derived from class priority, never assumed to be this scope.
                const effective = effectiveLocalPath({ localizations: next, localPath: it.localPath });
                if (effective && effective !== text(it.localPath)) patch.localPath = effective;
                // A local-file `url` follows the physical file only when this scope owns it.
                if (text(it.url) && !isHttp(it.url) && effective) patch.url = effective;
            }

            if (Object.keys(patch).length) {
                S()?.updateItem?.('music', it.id, patch);
                updatedCount += 1;
            }
        });

        if (connection && !paths?.same?.(connection.path, dir)) {
            const connections = (state().musicPortConnections || []).map((entry) => (
                entry === connection ? { ...entry, path: dir } : entry
            ));
            S()?.update?.({ musicPortConnections: connections }, 'audioflix-music-port-rebase');
        }
        return { ok: true, updatedCount, total: items.length, targetDir: dir };
    }

    // Recalibrate/re-link local file paths for a scope to targetDir without downloading from online URLs.
    async function recalibrateScopePath(scope, key, targetDir) {
        const dir = text(paths?.stripQuotes?.(targetDir)).replace(/[/\\]+$/, '')
            || text(targetDir).replace(/[/\\]+$/, '');
        if (!dir) return { ok: false, reason: 'No target folder path provided.' };

        const previousDir = getScopeDirOwn(scope, key)
            || text((state().musicPortConnections || []).find((entry) => (
                scope === 'folder' && text(entry.folder).toLowerCase() === text(key).toLowerCase()
            ))?.path);
        const migration = updateScopeDir(scope, key, dir);
        let scannedMatches = 0;

        const N = window.EveAudioflixNative;
        if (N?.scanLocalized) {
            try {
                const scan = await N.scanLocalized(dir);
                if (scan?.ok && Array.isArray(scan.files)) {
                    const items = collectScope(scope, key);
                    items.forEach((it) => {
                        const match = paths?.matchScannedFile?.(
                            it, scan.files, [previousDir, dir], scan.dir || dir
                        );
                        if (!match?.path) return;
                        const source = scope === 'song' ? sourceForScope(scope, key, it) : `${scope}:${key}`;
                        const current = Array.isArray(it.localizations) ? it.localizations : [];
                        const hasSource = current.some((entry) => sameText(entry.source, source));
                        const localizations = hasSource
                            ? current.map((entry) => sameText(entry.source, source)
                                ? { ...entry, source, path: match.path }
                                : entry)
                            : [...current, { source, path: match.path, kind: 'file' }];
                        const localPath = effectiveLocalPath({ ...it, localizations });
                        S()?.updateItem?.('music', it.id, {
                            localizations,
                            localPath,
                            missingLocal: false,
                            ...(isHttp(it.url) ? {} : { url: localPath })
                        });
                        scannedMatches += 1;
                    });
                }
            } catch {}
        }

        return {
            ok: true,
            recalibrated: Math.max(migration.updatedCount, scannedMatches),
            total: migration.total,
            targetDir: dir
        };
    }

    // --- Localization class model -------------------------------------------------------------
    // A track can be localized under several scopes at once. Its EFFECTIVE local file is picked by
    // class priority: 1st = a folder file, 3rd = a group shortcut (a reference to a file localized
    // elsewhere, so we never duplicate it), 2nd/dup = a group's own file. localPath is kept in sync
    // with the winner so playback (audio.js -> getLocalFileUrl) needs no change.
    const locClass = (l) => (l.source.startsWith('folder:') && l.kind === 'file') ? 0
        : (l.source.startsWith('group:') && l.kind === 'shortcut') ? 1
            : (l.source.startsWith('group:') && l.kind === 'file') ? 2 : 3;
    const orderedLocs = (track) => [...(track.localizations || [])].filter((l) => text(l.path)).sort((a, b) => locClass(a) - locClass(b));
    function effectiveLocalPath(track) {
        const ordered = orderedLocs(track);
        return ordered.length ? ordered[0].path : text(track?.localPath);
    }
    // Add/replace a track's localization for one source, then refresh its effective localPath.
    // `linkOf` (shortcuts only) records the PHYSICAL file the link points at, so the disk sensor can
    // verify the real bytes rather than deciding a shortcut is missing.
    function addLocalization(track, source, path, kind = 'file', linkOf = '') {
        const cleanPath = text(path);
        if (!track?.id || !cleanPath || !source) return;
        const next = (track.localizations || []).filter((l) => !sameText(l.source, source));
        next.push(linkOf ? { source, path: cleanPath, kind, linkOf: text(linkOf) } : { source, path: cleanPath, kind });
        S()?.updateItem?.('music', track.id, { localizations: next, localPath: effectiveLocalPath({ localizations: next, localPath: track.localPath }) });
    }
    // library/song localize attributes to the track's own folder (so it counts as 1st class) or a
    // manual tag; folder/group scopes map straight through.
    function sourceForScope(scope, key, track) {
        if (scope === 'folder') return `folder:${key}`;
        if (scope === 'group') return `group:${key}`;
        const folder = text(track.folder || track.card);
        return folder ? `folder:${folder}` : `manual:${track.id}`;
    }

    // Spotify tracks are NOT refused here any more. Spotify's own audio is Widevine-encrypted and
    // still never downloaded; what the server does instead is read the track's public metadata and
    // localize the YouTube video holding the same recording, matched on exact duration. Blocking the
    // call client-side meant that server capability was unreachable from the UI — the download only
    // ever ran from a script. An owned local file still wins: localizeScope recalibrates first, so a
    // track that already has the real file on disk never reaches this function at all.
    async function downloadInto(N, it, dir, mediaFormat = 'audio') {
        const res = await N.localizeTrack({ id: it.id, title: it.title, url: it.url }, dir, { mediaFormat });
        return (res?.ok && res.filePath) ? { ok: true, path: res.filePath } : { ok: false, error: res?.error || res?.message || 'download failed' };
    }

    // Group localization, three ways (class priority always decides playback):
    //   'link'  — reuse: folder copy stays 1st; already-local elsewhere becomes a 3rd-class shortcut
    //             (no second copy on disk); the rest download into the group path (2nd class).
    //   'smart' — no shortcuts: folder copies skipped, every other online song downloads here.
    //   'dup'   — ignore classes: own copy of every song here (folder file still plays first).
    async function localizeGroup(groupKey, dir, onProgress, mode = 'link', mediaFormat = 'audio') {
        const N = window.EveAudioflixNative;
        const source = `group:${groupKey}`;
        const members = collectScope('group', groupKey);
        let done = 0, shortcut = 0, skipped = 0, failed = 0, lastError = '';
        for (let i = 0; i < members.length; i += 1) {
            const it = members[i];
            onProgress?.({ index: i + 1, total: members.length, title: it.title });
            const folderFile = (it.localizations || []).find((l) => l.source.startsWith('folder:') && l.kind === 'file' && text(l.path));
            // A real file this track already has somewhere else (another group, or a legacy localPath).
            const elsewhereFile = (it.localizations || []).find((l) => l.kind === 'file' && text(l.path) && l.source !== source)
                || (text(it.localPath) ? { path: it.localPath } : null);
            if (mode !== 'dup' && folderFile) { skipped += 1; continue; }        // 1st class stays primary
            if (mode === 'link' && elsewhereFile) {                              // 3rd class: reference it
                // Create a REAL link in the group folder so the shortcut exists on disk too (it used
                // to be EveOS-only, so the group's path looked empty in Explorer). The stored path is
                // the link inside this group; `linkOf` remembers the physical file it points at, which
                // is what keeps the disk sensor from reading it as missing.
                const linked = await N?.linkLocalFile?.(elsewhereFile.path, dir, it.title);
                if (linked?.ok && linked.path) addLocalization(it, source, linked.path, 'shortcut', elsewhereFile.path);
                else addLocalization(it, source, elsewhereFile.path, 'shortcut', elsewhereFile.path);
                shortcut += 1;
                continue;
            }
            if (!isHttp(it.url)) { skipped += 1; continue; }
            const dl = await downloadInto(N, it, dir, mediaFormat);
            if (dl.ok) { addLocalization(it, source, dl.path, 'file'); done += 1; }
            else { failed += 1; lastError = dl.error; }
        }
        return { ok: failed === 0 || done + shortcut > 0, done, shortcut, skipped, failed, total: members.length, targetDir: dir, mode, lastError };
    }

    // Download every candidate in the scope to targetDir, tagging each with a scope-appropriate
    // localization. `force` re-downloads already-local tracks (relocalize). Group scope dispatches
    // to the class-aware path (`mode`).
    async function localizeScope(scope, key, targetDir, onProgress, force = false, mode = 'link', mediaFormat = 'audio') {
        const N = window.EveAudioflixNative;
        if (!N?.localizeTrack) return { ok: false, reason: 'Localization needs the EveOS localhost server running.' };
        const dir = text(targetDir);
        if (!dir) return { ok: false, reason: 'No target folder was chosen.' };
        // Attach already-owned files before considering a network localization. This keeps a file the
        // user actually owns ahead of any download (which matters most for Spotify tracks, whose
        // download is a YouTube match rather than the Spotify master) and avoids re-fetching other
        // dual-source tracks that are already present under a newly selected directory.
        await recalibrateScopePath(scope, key, dir);
        if (scope === 'group') return localizeGroup(key, dir, onProgress, mode, mediaFormat);
        const items = localizeCandidates(scope, key, force);
        if (!items.length) return { ok: true, done: 0, failed: 0, total: 0, targetDir: dir, note: 'Nothing to localize.' };
        let done = 0, failed = 0, lastError = '';
        for (let i = 0; i < items.length; i += 1) {
            const it = items[i];
            onProgress?.({ index: i + 1, total: items.length, title: it.title });
            const dl = await downloadInto(N, it, dir, mediaFormat);
            if (dl.ok) { addLocalization(it, sourceForScope(scope, key, it), dl.path, 'file'); done += 1; }
            else { failed += 1; lastError = dl.error; }
        }
        return { ok: done > 0 || failed === 0, done, failed, total: items.length, targetDir: dir, lastError };
    }

    // For a group's "view paths" popover: 1st-class folder files of its members + the group's own
    // files/shortcuts, plus the group's remembered directory.
    function groupLocalizationPaths(groupKey) {
        const members = collectScope('group', groupKey);
        const firstClass = [], groupPaths = [], inheritedPaths = [];
        members.forEach((it) => {
            const locs = (it.localizations && it.localizations.length) ? it.localizations : (it.localPath ? [{ source: `folder:${it.folder || it.card || 'General'}`, path: it.localPath, kind: 'file' }] : []);
            const folderLoc = locs.find((l) => l.source.startsWith('folder:') && l.kind === 'file' && text(l.path));
            const ownGroupLoc = locs.find((l) => sameText(l.source, `group:${groupKey}`) && text(l.path));
            if (folderLoc) {
                firstClass.push({ id: it.id, title: it.title, source: folderLoc.source.slice(7), path: folderLoc.path });
            }
            if (ownGroupLoc) {
                groupPaths.push({ id: it.id, title: it.title, kind: ownGroupLoc.kind, path: ownGroupLoc.path });
            }
            if (!folderLoc && !ownGroupLoc) {
                const inherited = orderedLocs(it)[0] || (text(it.localPath) ? { path: it.localPath, source: 'legacy' } : null);
                if (inherited) inheritedPaths.push({ id: it.id, title: it.title, source: inherited.source, path: inherited.path });
            }
        });
        const coveredIds = new Set([...firstClass, ...groupPaths, ...inheritedPaths].map((entry) => entry.id));
        return {
            firstClass,
            groupPaths,
            inheritedPaths,
            memberCount: members.length,
            uncoveredCount: members.filter((item) => !coveredIds.has(item.id)).length,
            groupDir: getScopeDir('group', groupKey)
        };
    }

    // For the song settings panel: this track's localizations, most-important class first.
    function songLocalizationList(track) {
        return orderedLocs(track).map((l) => ({
            label: l.source.startsWith('folder:') ? `Folder · ${l.source.slice(7)}`
                : l.kind === 'shortcut' ? `Group shortcut · ${l.source.slice(6)}`
                    : l.source.startsWith('group:') ? `Group · ${l.source.slice(6)}` : l.source,
            path: l.path,
            kind: l.kind,
            source: l.source,
            linkOf: text(l.linkOf)
        }));
    }

    // Music port: scan a folder and re-attach files to tracks by title, restoring localPath.
    async function reimportMerge(dir) {
        const N = window.EveAudioflixNative;
        if (!N?.scanLocalized) return { ok: false, reason: 'Reimport needs the EveOS localhost server running.' };
        const scan = await N.scanLocalized(dir);
        if (!scan?.ok) return { ok: false, reason: scan?.message || 'Could not read that folder.' };
        const byTitle = new Map();
        musicItems().forEach((it) => { const k = normTitle(it.title); if (k && !byTitle.has(k)) byTitle.set(k, it); });
        let matched = 0;
        (scan.files || []).forEach((f) => {
            const it = byTitle.get(normTitle(f.name));
            if (it && f.path && text(it.localPath) !== f.path) { S()?.updateItem?.('music', it.id, { localPath: f.path }); matched += 1; }
        });
        return { ok: true, matched, scanned: (scan.files || []).length, dir: scan.dir };
    }

    // Music Port (folder -> tracks, sub-folder names -> classifiers, plus folder sync) lives in a
    // sibling module; it shares this module's state primitives.
    const { extractSubfolders, importMusicPort, syncMusicPortFolder } =
        window.EveAudioflixLocalizePort.create({
            S, state, text, paths, musicItems, rememberDir, getScopeDir, effectiveLocalPath
        });

    // Point one localization entry at a different file (user edit from the track settings panel).
    // Only that entry moves; the effective localPath is then re-derived from class priority.
    function setLocalizationPath(trackId, source, newPath) {
        const track = musicItems().find((it) => it.id === trackId);
        const clean = text(newPath);
        if (!track || !clean) return { ok: false };
        const next = (track.localizations || []).map((l) => (sameText(l.source, source) ? { ...l, path: clean } : l));
        if (!next.some((l) => sameText(l.source, source))) return { ok: false, reason: 'Unknown localization entry.' };
        S()?.updateItem?.('music', trackId, { localizations: next, localPath: effectiveLocalPath({ localizations: next, localPath: track.localPath }) });
        return { ok: true };
    }

    Object.assign(ns, {
        ready: true,
        setLocalizationPath,
        lastDir,
        getScopeDir,
        getScopeDirOwn,
        updateScopeDir,
        recalibrateScopePath,
        auditScopeDiskStatus,
        collectScope,
        localizeCandidates,
        scopeStats,
        effectiveLocalPath,
        localizeScope,
        localizeGroup,
        groupLocalizationPaths,
        songLocalizationList,
        reimportMerge,
        importMusicPort,
        syncMusicPortFolder
    });
})();
