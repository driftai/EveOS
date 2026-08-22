// Merge-only Audioflix tab backups. Full EveOS backups still carry the complete Audioflix store;
// this surface exists for moving one user library without replacing unrelated Audioflix state.
(function () {
    'use strict';

    const FORMAT = 'eveos-audioflix-tab';
    const VERSION = 1;
    const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
    const SOUND_FIELDS = [
        'soundboard', 'soundboardGroups', 'soundGroupMap', 'ports', 'browserFolders',
        'portVolumes', 'exposedPortedSounds', 'portHotkeys', 'soundboardViewMode',
        'activeFrontendGroup', 'hotkeyBypassCombo'
    ];
    const MUSIC_FIELDS = [
        'music', 'musicGroups', 'musicGroupMap', 'musicPlaylists', 'musicPortConnections',
        'musicClassifiers', 'dupDismissedPairs', 'musicViewMode', 'activeFrontendMusicGroup',
        'activeFrontendMusicArtist', 'activeFrontendMusicClassifier', 'activeMusicFolderScope',
        'showPlaylistMarkersOnCard', 'localizeDir', 'localizeScopeDirs'
    ];

    const clone = (value) => JSON.parse(JSON.stringify(value == null ? null : value));
    const list = (value) => Array.isArray(value) ? value : [];
    const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const unique = (values) => [...new Set(list(values).map((value) => String(value || '').trim()).filter(Boolean))];
    const normalizeUrl = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '';
        try {
            const parsed = new URL(raw);
            parsed.hash = '';
            return parsed.toString().replace(/\/$/, '').toLowerCase();
        } catch (_) {
            return raw.replace(/\/$/, '').toLowerCase();
        }
    };
    const normalizePath = (value) => String(value || '').trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

    function status(message, kind = 'info') {
        const target = document.getElementById('audioflixBackupStatus');
        if (target) {
            target.textContent = message;
            target.dataset.status = kind;
        }
        if (kind !== 'info' && typeof window.showToast === 'function') window.showToast(message, kind);
    }

    function fieldsFor(tab) {
        return tab === 'soundboard' ? SOUND_FIELDS : MUSIC_FIELDS;
    }

    function snapshotFor(tab) {
        const state = window.EveAudioflixState?.getSnapshot?.() || {};
        const data = {};
        fieldsFor(tab).forEach((key) => { data[key] = clone(state[key]); });
        data.scopeBindings = clone(list(state.scopeBindings).filter((entry) => entry?.audioType === (tab === 'soundboard' ? 'sound' : 'music')));
        return data;
    }

    function downloadJson(payload, name) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function exportAudioflixTabBackup(tabValue) {
        const tab = tabValue === 'soundboard' ? 'soundboard' : 'music';
        const data = snapshotFor(tab);
        const count = tab === 'soundboard' ? list(data.soundboard).length : list(data.music).length;
        const payload = { format: FORMAT, version: VERSION, tab, exportedAt: new Date().toISOString(), data };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadJson(payload, `eveos-audioflix-${tab}-${stamp}.json`);
        status(`Exported ${count} ${tab === 'soundboard' ? 'soundboard clips' : 'music tracks'} with their organization metadata.`);
    }

    function itemIdentity(item) {
        const keys = [];
        const url = normalizeUrl(item?.url);
        const path = normalizePath(item?.localPath);
        const provider = String(item?.sourceProvider || '').trim().toLowerCase();
        const sourceId = String(item?.sourceId || '').trim().toLowerCase();
        if (url) keys.push(`url:${url}`);
        if (path) keys.push(`path:${path}`);
        if (provider && sourceId) keys.push(`source:${provider}:${sourceId}`);
        return keys;
    }

    function mergeLocalizations(left, right) {
        const seen = new Set();
        return [...list(left), ...list(right)].filter((entry) => {
            const key = [normalizePath(entry?.path), String(entry?.source || ''), String(entry?.kind || '')].join('|');
            if (!key.replace(/\|/g, '') || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function mergeItem(existing, incoming) {
        const next = { ...existing };
        Object.entries(object(incoming)).forEach(([key, value]) => {
            if (value == null || (typeof value === 'string' && !value.trim())) return;
            if (key !== 'id' && key !== 'classifiers' && key !== 'localizations') next[key] = clone(value);
        });
        next.id = existing.id;
        next.classifiers = unique([...list(existing.classifiers), ...list(incoming.classifiers)]);
        next.localizations = mergeLocalizations(existing.localizations, incoming.localizations);
        next.createdAt = Math.min(Number(existing.createdAt || Date.now()), Number(incoming.createdAt || Date.now()));
        next.updatedAt = Math.max(Number(existing.updatedAt || 0), Number(incoming.updatedAt || 0));
        next.lastPlayedAt = Math.max(Number(existing.lastPlayedAt || 0), Number(incoming.lastPlayedAt || 0));
        return next;
    }

    function mergeItems(currentItems, importedItems) {
        const result = list(currentItems).map(clone);
        const idMap = new Map();
        for (const incoming of list(importedItems)) {
            if (!incoming || typeof incoming !== 'object') continue;
            const identities = new Set(itemIdentity(incoming));
            const index = result.findIndex((entry) => String(entry.id) === String(incoming.id)
                || itemIdentity(entry).some((key) => identities.has(key)));
            if (index >= 0) {
                idMap.set(String(incoming.id || ''), String(result[index].id));
                result[index] = mergeItem(result[index], incoming);
            } else {
                const added = clone(incoming);
                if (!added.id) added.id = `audio_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
                idMap.set(String(incoming.id || added.id), String(added.id));
                result.push(added);
            }
        }
        return { items: result, idMap };
    }

    function mergeIdMap(currentMap, incomingMap, idMap) {
        const merged = { ...object(currentMap) };
        Object.entries(object(incomingMap)).forEach(([oldId, values]) => {
            const id = idMap.get(String(oldId)) || String(oldId);
            merged[id] = unique([...list(merged[id]), ...list(values)]);
        });
        return merged;
    }

    function mergeRecordSet(current, incoming, keys) {
        const result = list(current).map(clone);
        const idMap = new Map();
        list(incoming).forEach((entry) => {
            if (!entry || typeof entry !== 'object') return;
            const index = result.findIndex((candidate) => keys.some((key) => {
                const left = String(candidate?.[key] || '').trim().toLowerCase();
                const right = String(entry?.[key] || '').trim().toLowerCase();
                return left && right && left === right;
            }));
            if (index >= 0) {
                const retainedId = result[index].id || entry.id;
                idMap.set(String(entry.id || ''), String(retainedId || ''));
                result[index] = { ...result[index], ...clone(entry), id: retainedId };
            } else {
                const added = clone(entry);
                result.push(added);
                idMap.set(String(entry.id || ''), String(added.id || ''));
            }
        });
        return { records: result, idMap };
    }

    function mergeRecords(current, incoming, keys) {
        return mergeRecordSet(current, incoming, keys).records;
    }

    function mergeKeyedOptions(current, incoming, idMap) {
        const merged = { ...object(current) };
        Object.entries(object(incoming)).forEach(([oldId, value]) => {
            const id = idMap.get(String(oldId)) || String(oldId);
            if (id) merged[id] = clone(value);
        });
        return merged;
    }

    function remapDismissedPairs(values, idMap) {
        return list(values).map((value) => {
            const [left, right] = String(value || '').split('|');
            if (!left || !right) return '';
            return [idMap.get(left) || left, idMap.get(right) || right].sort().join('|');
        }).filter(Boolean);
    }

    function mergeBindings(current, incoming, idMap, audioType) {
        const merged = list(current).map(clone);
        const seen = new Set(merged.map((entry) => [entry.audioType, entry.audioId, entry.scopeType, entry.workspaceId, entry.categoryName, entry.folderId, entry.bookmarkId].join('|')));
        list(incoming).forEach((raw) => {
            if (!raw || raw.audioType !== audioType) return;
            const entry = { ...clone(raw), audioId: idMap.get(String(raw.audioId || '')) || String(raw.audioId || '') };
            const key = [entry.audioType, entry.audioId, entry.scopeType, entry.workspaceId, entry.categoryName, entry.folderId, entry.bookmarkId].join('|');
            if (entry.audioId && !seen.has(key)) { seen.add(key); merged.push(entry); }
        });
        return merged;
    }

    function hasImportContent(tab, data) {
        if (tab === 'soundboard') return list(data.soundboard).length > 0 || list(data.soundboardGroups).length > 0 || list(data.ports).length > 0;
        return list(data.music).length > 0 || list(data.musicGroups).length > 0 || list(data.musicPlaylists).length > 0;
    }

    function mergeBackup(tab, data) {
        const current = window.EveAudioflixState?.getSnapshot?.() || {};
        const sound = tab === 'soundboard';
        const key = sound ? 'soundboard' : 'music';
        const playlistSet = sound
            ? null
            : mergeRecordSet(current.musicPlaylists, data.musicPlaylists, ['id', 'url', 'playlistId']);
        const incomingItems = sound ? data[key] : list(data[key]).map((item) => ({
            ...clone(item),
            playlistId: playlistSet.idMap.get(String(item?.playlistId || '')) || item?.playlistId
        }));
        const mergedItems = mergeItems(current[key], incomingItems);
        const patch = { ...current, [key]: mergedItems.items };
        if (sound) {
            patch.soundboardGroups = unique([...list(current.soundboardGroups), ...list(data.soundboardGroups)]);
            patch.soundGroupMap = mergeIdMap(current.soundGroupMap, data.soundGroupMap, mergedItems.idMap);
            patch.ports = mergeRecords(current.ports, data.ports, ['id', 'path']);
            patch.browserFolders = mergeRecords(current.browserFolders, data.browserFolders, ['id']);
            patch.portVolumes = mergeKeyedOptions(current.portVolumes, data.portVolumes, mergedItems.idMap);
            patch.exposedPortedSounds = mergeKeyedOptions(current.exposedPortedSounds, data.exposedPortedSounds, mergedItems.idMap);
            patch.portHotkeys = mergeKeyedOptions(current.portHotkeys, data.portHotkeys, mergedItems.idMap);
            ['soundboardViewMode', 'activeFrontendGroup', 'hotkeyBypassCombo'].forEach((field) => {
                if (data[field] != null) patch[field] = data[field];
            });
        } else {
            patch.musicGroups = unique([...list(current.musicGroups), ...list(data.musicGroups)]);
            patch.musicGroupMap = mergeIdMap(current.musicGroupMap, data.musicGroupMap, mergedItems.idMap);
            patch.musicPlaylists = playlistSet.records;
            patch.musicPortConnections = mergeRecords(current.musicPortConnections, data.musicPortConnections, ['id', 'path']);
            patch.musicClassifiers = unique([...list(current.musicClassifiers), ...list(data.musicClassifiers)]);
            patch.dupDismissedPairs = unique([
                ...list(current.dupDismissedPairs),
                ...remapDismissedPairs(data.dupDismissedPairs, mergedItems.idMap)
            ]);
            patch.localizeScopeDirs = { ...object(current.localizeScopeDirs), ...object(data.localizeScopeDirs) };
            ['musicViewMode', 'activeFrontendMusicGroup', 'activeFrontendMusicArtist', 'activeFrontendMusicClassifier', 'activeMusicFolderScope', 'showPlaylistMarkersOnCard', 'localizeDir'].forEach((field) => {
                if (data[field] != null) patch[field] = data[field];
            });
        }
        patch.scopeBindings = mergeBindings(current.scopeBindings, data.scopeBindings, mergedItems.idMap, sound ? 'sound' : 'music');
        return window.EveAudioflixState?.replaceState?.(patch, `audioflix-${tab}-backup-merge`) || patch;
    }

    async function importAudioflixTabBackup(input, expectedTab) {
        const file = input?.files?.[0];
        if (!file) return;
        try {
            if (file.size > MAX_IMPORT_BYTES) throw new Error('Audioflix backup is larger than 64 MB.');
            const payload = JSON.parse(await file.text());
            if (payload?.format !== FORMAT || Number(payload?.version) !== VERSION) throw new Error('This is not a supported Audioflix tab backup.');
            const tab = payload.tab === 'soundboard' ? 'soundboard' : payload.tab === 'music' ? 'music' : '';
            if (!tab || tab !== expectedTab) throw new Error(`Choose a ${expectedTab === 'soundboard' ? 'Soundboard' : 'Music Library'} backup.`);
            const data = object(payload.data);
            if (!hasImportContent(tab, data)) throw new Error('The backup contains no Audioflix user content to merge.');
            const merged = mergeBackup(tab, data);
            window.EveAudioflixState?.flush?.(`audioflix-${tab}-backup-import`);
            const count = tab === 'soundboard' ? list(merged.soundboard).length : list(merged.music).length;
            refreshAudioflixBackupPanel();
            status(`Merged the ${tab === 'soundboard' ? 'Soundboard' : 'Music Library'} backup. The library now contains ${count} items.`, 'success');
        } catch (error) {
            status(error?.message || 'Audioflix backup import failed.', 'error');
        } finally {
            if (input) input.value = '';
        }
    }

    function refreshAudioflixBackupPanel() {
        const state = window.EveAudioflixState?.ensure?.() || {};
        status(`${list(state.soundboard).length} saved sounds · ${list(state.music).length} saved tracks. Full EveOS backups include both; tab imports merge without wiping existing data.`);
    }

    Object.assign(window, { exportAudioflixTabBackup, importAudioflixTabBackup, refreshAudioflixBackupPanel });
})();

// Piano Auto Player owns a separate song library on its local service. Surface that library beside
// Soundboard and Music Library without folding its binary ZIP format into EveAudioflixState.
(function () {
    'use strict';

    const MAX_PIANO_IMPORT_BYTES = 100 * 1024 * 1024;

    function pianoServiceUrl() {
        const direct = window.EveAudioflixPiano?.serviceUrl?.();
        if (direct) return String(direct).replace(/\/?$/, '/');
        const port = Number(window.config?.bridges?.pianoPlayerPort) || 8771;
        return `http://127.0.0.1:${port}/`;
    }

    function pianoStatus(message, kind = 'info') {
        const target = document.getElementById('audioflixBackupStatus');
        if (target) {
            target.textContent = message;
            target.dataset.status = kind;
        }
        if (kind === 'error' && typeof window.showToast === 'function') window.showToast(message, 'error');
    }

    function downloadBlob(blob, name) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function exportPianoLibraryBackup() {
        try {
            pianoStatus('Exporting the Piano Auto Player library…');
            const response = await fetch(`${pianoServiceUrl()}api/library/export`, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Piano service returned HTTP ${response.status}.`);
            const blob = await response.blob();
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            downloadBlob(blob, `eveos-piano-auto-player-${stamp}.zip`);
            pianoStatus('Exported the Piano Auto Player song library.', 'success');
        } catch (error) {
            pianoStatus(`Piano Auto Player export failed: ${error?.message || 'service unavailable'}. Start the Piano Auto Player service and try again.`, 'error');
        }
    }

    async function importPianoLibraryBackup(input) {
        const file = input?.files?.[0];
        if (!file) return;
        try {
            if (file.size > MAX_PIANO_IMPORT_BYTES) throw new Error('Piano library backup is larger than 100 MB.');
            pianoStatus('Merging the Piano Auto Player library…');
            const response = await fetch(`${pianoServiceUrl()}api/library/import?filename=${encodeURIComponent(file.name || 'piano-library.zip')}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result?.error) throw new Error(result?.error || `Piano service returned HTTP ${response.status}.`);
            const imported = Number(result?.imported ?? result?.merged ?? result?.count);
            const suffix = Number.isFinite(imported) ? ` ${imported} song${imported === 1 ? '' : 's'} processed.` : '';
            pianoStatus(`Merged the Piano Auto Player library.${suffix} Existing songs were preserved unless their matching IDs were updated.`, 'success');
        } catch (error) {
            pianoStatus(`Piano Auto Player import failed: ${error?.message || 'service unavailable'}`, 'error');
        } finally {
            if (input) input.value = '';
        }
    }

    function installPianoBackupRow() {
        const statusNode = document.getElementById('audioflixBackupStatus');
        if (!statusNode || document.querySelector('[data-audioflix-piano-backup-row]')) return;
        const row = document.createElement('div');
        row.className = 'btn-action-row';
        row.dataset.audioflixPianoBackupRow = 'true';
        row.style.marginTop = '8px';
        row.innerHTML = `<button type="button" onclick="exportPianoLibraryBackup()" class="btn-backup">Export Piano Auto Player</button><label class="btn-restore" style="cursor:pointer; margin:0;">Import Piano Auto Player<input type="file" accept=".zip,.json,application/zip,application/json" hidden onchange="importPianoLibraryBackup(this)"></label>`;
        const note = document.createElement('div');
        note.dataset.audioflixPianoBackupNote = 'true';
        note.style.cssText = 'margin-top:6px; font-size:0.78rem; opacity:0.72;';
        note.textContent = 'Piano Auto Player exports its live song-library ZIP. Imports merge by song ID and do not wipe the existing Piano library.';
        statusNode.parentNode?.insertBefore(row, statusNode);
        statusNode.parentNode?.insertBefore(note, statusNode);
    }

    const refreshBase = window.refreshAudioflixBackupPanel;
    window.refreshAudioflixBackupPanel = function (...args) {
        const result = refreshBase?.apply(this, args);
        installPianoBackupRow();
        return result;
    };
    Object.assign(window, { exportPianoLibraryBackup, importPianoLibraryBackup });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installPianoBackupRow, { once: true });
    else installPianoBackupRow();
})();
