// Track/sound settings modal for the Audioflix panel (the cog panel): details rows, duplicate
// manager, group assignment, classifiers, localization paths and the per-track localize form. Split
// out of audioflix.ui.js to keep that view under the project line cap; every helper and open-flag it
// needs arrives through the `ctx` bag so this module stays stateless.
window.EveAudioflixUiModal = window.EveAudioflixUiModal || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixUiModal;
    if (ns.ready) return;

    ns.create = function create(ctx) {
        const { esc, closeSvg, state, formatDuration, isItemExposed, groupsOf, allGroups,
            internalViewButton, findItem, uiLoc, uiClass, renderLocalizeForm } = ctx;
        const activeRepeaters = ctx.getActiveRepeaters;
        const localizeFormOpen = ctx.getLocalizeFormOpen;
        const deleteConfirmId = ctx.getDeleteConfirmId || (() => '');

        const renderInfoModal = (item, type) => {
            const dur = formatDuration(item.duration), src = item.isPorted ? `${item.category} (Ported)` : (type === 'music' ? 'Music Library' : 'Local Soundboard'), row = (lbl, val) => `<div class="audioflix-info-row"><span>${lbl}</span><strong>${val}</strong></div>`;
            const creatorRow = item.creator ? row('Creator', `@${esc(item.creator)}`) : '';
            const audioRow = item.audioTitle ? row('Audio', esc(item.audioTitle)) : '';
            const exposeRow = row('Expose to Frontend', `<input type="checkbox" class="audioflix-expose-cb" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" ${isItemExposed(item, type) ? 'checked' : ''}>`);
            const spotifyTransportRow = type === 'music'
                && (item.sourceProvider === 'spotify' || /open\.spotify\.com\/(?:embed\/)?track\//i.test(String(item.url || '')))
                ? row('Compact Spotify Panel', `<input type="checkbox" class="audioflix-provider-transport-toggle"
                    data-af-type="music" data-af-id="${esc(item.id)}"
                    title="Show Spotify's compact provider panel during normal card playback"
                    ${item.showProviderTransport === true ? 'checked' : ''}>`)
                : '';
            const hotkeyRow = type === 'sound' ? row('Global Hotkey', `<input type="text" class="audioflix-hotkey-input" placeholder="e.g. ctrl+y, f5" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" value="${esc(item.hotkey || '')}">`) : '';
            const rep = activeRepeaters()[item.id], repeaterBlock = type === 'sound' ? `<div class="audioflix-repeater"><span class="audioflix-repeater-title">Sound Repeater</span><div class="audioflix-repeater-row"><label class="audioflix-repeater-field"><span>Interval (sec)</span><input type="number" step="0.1" min="0.1" value="${rep ? rep.intervalMs / 1000 : 1.0}" id="audioflix-rep-interval" ${rep ? 'disabled' : ''}></label><label class="audioflix-repeater-field"><span>Count (0 = inf)</span><input type="number" min="0" value="${rep ? rep.count : 0}" id="audioflix-rep-count" ${rep ? 'disabled' : ''}></label><button type="button" class="audioflix-repeater-btn${rep ? ' is-active' : ''}" data-af-action="toggle-repeater" data-af-id="${esc(item.id)}">${rep ? 'Stop' : 'Start'}</button></div></div>` : '';
            const trackEditBlock = type === 'music' ? `<form class="audioflix-track-edit-form" data-af-form="edit-track" data-af-id="${esc(item.id)}"><span class="audioflix-info-groups-label" style="display:block; margin-bottom:6px;">Edit Track Details</span><div class="audioflix-track-edit-grid"><label><span>Track Title</span><input name="title" value="${esc(item.title)}" required></label><label><span>URL / Path</span><input name="url" value="${esc(item.url)}" required></label><label><span>Artist</span><input name="artist" value="${esc(item.artist || '')}"></label><label><span>Folder / Card</span><input name="folder" value="${esc(item.folder || item.card || '')}"></label><label class="audioflix-wide-field" style="grid-column: span 2; margin-top: 4px;"><span>Local Path (offline copy)</span><input name="localPath" value="${esc(item.localPath || '')}" placeholder="C:\\path\\to\\offline\\file.mp3"></label></div><button type="submit" class="audioflix-save-track-btn" data-af-action="submit-form">Save Track Edits</button></form>` : '';
            
            const dupMatches = window.EveAudioflixDuplicates?.duplicateInfoFor?.(type, item.id) || [];
            let dupSection = '';
            if (dupMatches.length) {
                const srcKind = (u) => (/^https?:\/\//i.test(String(u || '')) ? 'online' : (u ? 'local file' : ''));
                const matchItems = dupMatches.map(info => {
                    const d = info.item;
                    const kind = srcKind(d.url);
                    const kindTag = kind ? ` <em style="color:#94a3b8; font-style:normal;">· ${kind}</em>` : '';
                    const color = info.level === 'soft' ? '#f59e0b' : '#ef4444';
                    return `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:4px; padding:6px 10px; background:${color}22; border-radius:4px; font-size:0.85rem;"><span style="color:#f8fafc; min-width:0; overflow:hidden; text-overflow:ellipsis;"><strong style="color:${color};">${info.level === 'soft' ? 'Soft match' : 'Duplicate'}</strong> · ${esc(d.title)} <code style="color:#cbd5e1;">(${esc(d.folder || d.category || 'Ungrouped')})</code>${kindTag}<small style="display:block;color:#94a3b8;">${esc(info.reason)}</small></span><span style="display:flex; gap:6px; flex:none;"><button type="button" class="audioflix-save-track-btn" data-af-action="merge-duplicate" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" data-af-dupid="${esc(d.id)}" style="background:${color}; color:#fff; padding:2px 8px; font-size:0.75rem;">Merge Into This</button><button type="button" class="audioflix-save-track-btn" data-af-action="keep-both-duplicate" data-af-id="${esc(item.id)}" data-af-dupid="${esc(d.id)}" style="background:rgba(148,163,184,0.25); color:#e2e8f0; padding:2px 8px; font-size:0.75rem;">Keep Both</button></span></div>`;
                }).join('');
                const onlySoft = dupMatches.every((entry) => entry.level === 'soft');
                const boxColor = onlySoft ? '#f59e0b' : '#ef4444';
                dupSection = `<div class="audioflix-dup-manager-box" style="margin-top:12px; padding:10px; background:${boxColor}1f; border:1px solid ${boxColor}59; border-radius:6px;"><strong style="color:${boxColor}; font-size:0.9rem;">${onlySoft ? 'Possible related versions' : 'Duplicate detected'} (${dupMatches.length})</strong><p style="font-size:0.8rem; color:#cbd5e1; margin:4px 0 8px;">Hard duplicates share a URL, local path, or provider identity. Soft matches only share a title or file name and may be a clip, edit, or alternate version. Merge only after review; <strong>Keep Both</strong> dismisses the notice without deleting either item.</p>${matchItems}</div>`;
            }

            // Dual-source tracks (from a duplicate merge) carry a local file alongside the online url.
            const localSourceRow = (type === 'music' && item.localPath) ? `<div class="audioflix-info-url-container"><span>Local file (offline copy)</span><div class="audioflix-info-url-row"><input type="text" readonly value="${esc(item.localPath)}" class="audioflix-info-url-input" onclick="this.select()"><button type="button" class="audioflix-info-copy-btn" data-af-action="copy-url" data-af-url="${esc(item.localPath)}">Copy</button></div></div>` : '';
            // Collapsible localize control for this single track (relocalize stays available even after
            // the local copy is deleted). Lives here in the settings panel, not a popup.
            // Playlist provenance lives here rather than on the song card: what this track is linked
            // to, whether it left the upstream playlist, plus the opt-in to mirror it onto the card.
            let provenanceSection = '';
            if (type === 'music') {
                const PL = window.EveAudioflixPlaylists;
                const conn = item.playlistId ? (PL?.connections?.() || []).find((c) => c.id === item.playlistId) : null;
                const chip = (txt, color) => `<span style="display:inline-flex; align-items:center; padding:1px 6px; border-radius:6px; font-size:0.72rem; font-weight:700; border:1px solid ${color}55; background:${color}22; color:${color}; margin-right:4px;">${txt}</span>`;
                const marks = [];
                if (PL?.isLibraryOnlyTrackInImportedGroup?.(item)) marks.push(chip('Library-only', '#c084fc'));
                if (item.upstreamMissing) marks.push(chip('⚠ Gone from source', '#f87171'));
                if (conn) marks.push(chip('🔗 Linked playlist', '#38bdf8'));
                const keepBtn = (item.upstreamMissing && item.playlistId)
                    ? `<button type="button" class="audioflix-add-toggle" data-af-action="keep-playlist-track" data-af-id="${esc(item.id)}" style="font-size:0.72rem; padding:2px 8px; border-radius:10px;">💾 Keep in EveOS</button>`
                    : '';
                const isInstagram = String(conn?.provider || '').toLowerCase() === 'instagram';
                const sourceLabel = isInstagram
                    ? (conn.group || conn.title || 'Instagram Reels')
                    : (conn?.url || '(none)');
                const sourcePrefix = isInstagram ? 'Playlist' : 'Source';
                const link = conn ? `<div style="margin-top:4px; font-size:0.72rem; color:#94a3b8;" title="${esc(conn.url || '')}">${sourcePrefix}: <code style="color:#8ab4f8;">${esc(sourceLabel)}</code></div>` : '';
                const toggle = `<label style="display:flex; align-items:center; gap:6px; font-size:0.75rem; color:#cbd5e1; margin-top:6px;"><input type="checkbox" class="audioflix-marker-toggle" ${state().showPlaylistMarkersOnCard === true ? 'checked' : ''}> Also show these markers on the song card</label>`;
                if (marks.length || conn) {
                    provenanceSection = `<div class="audioflix-info-groups" style="margin-top:10px;"><span class="audioflix-info-groups-label">Playlist status</span><div style="margin-top:4px;">${marks.join('')}${keepBtn}</div>${link}${toggle}</div>`;
                }
            }
            // A localized track only plays without the EveOS server if the browser holds a handle
            // for its folder — a path string alone is unreadable. Offer that grant HERE, naming the
            // exact folder, because this panel is where someone lands when a track will not play.
            const P = window.EveAudioflixPaths;
            const trackDir = type === 'music' ? (P?.dirname?.(item.localPath || (P?.isAbsoluteLocal?.(item.url) ? item.url : '')) || '') : '';
            // dirname normalizes to forward slashes; show it the way Windows shows it so the user
            // can match it against the folder picker.
            const trackDirDisplay = trackDir.replace(/\//g, '\\');
            const offlineRow = trackDir ? `<div class="audioflix-info-groups" style="margin-top:10px;"><span style="display:block; font-size:0.75rem; color:#94a3b8; margin-bottom:4px;">Offline playback folder</span><code style="display:block; font-size:0.78rem; color:#8ab4f8; word-break:break-all; margin-bottom:6px;">${esc(trackDirDisplay)}</code><button type="button" class="audioflix-add-toggle" data-af-action="grant-music-folder" data-af-folder="${esc(item.folder || item.card || '')}" data-af-nickname="${esc(P?.basename?.(trackDir) || trackDir)}">🔓 Grant Offline Access</button><p class="audioflix-settings-hint" style="margin:6px 0 0;">Pick the folder above once and this track (and every other track in it) plays with the EveOS server stopped.</p></div>` : '';
            const hasLocalClaim = type === 'music' && (Boolean(item.localPath) || (item.localizations || []).length > 0 || item.isMusicPort === true);
            const hasOnlineFallback = type === 'music' && /^https?:\/\//i.test(String(item.url || ''));
            const localHealthSection = hasLocalClaim ? `<div class="audioflix-info-groups audioflix-local-health-box" style="margin-top:10px;"><span class="audioflix-info-groups-label">Local copy health</span><div style="margin-top:4px;"><span class="audioflix-local-health-chip${item.missingLocal ? ' is-missing' : ' is-ok'}">${item.missingLocal ? '⚠ Local file not found' : '✓ Local file tracked'}</span>${item.isMusicPort ? '<span class="audioflix-local-health-chip">Music Port</span>' : ''}${item.localPath ? '<span class="audioflix-local-health-chip">Localized</span>' : ''}</div>${item.missingLocal ? '<p class="audioflix-settings-hint" style="margin:6px 0 0;">The expected local file moved or disappeared. Cached/browser playback may still work, and an online URL can remain a fallback, but this track is not currently secured at its tracked local path.</p>' : ''}${hasOnlineFallback ? `<label style="display:flex;align-items:center;gap:6px;font-size:0.75rem;color:#cbd5e1;margin-top:7px;"><input type="checkbox" class="audioflix-local-marker-toggle" ${state().showLocalMissingMarkersOnCard === true ? 'checked' : ''}> Show missing-local marker on dual-source song cards</label>` : ''}<button type="button" class="audioflix-add-toggle" data-af-action="audit-scope-disk" data-af-scope="song" data-af-key="${esc(item.id)}" style="margin-top:7px;">Verify local file now</button></div>` : '';
            const canLocalizeSong = type === 'music' && (Boolean(item.url) || Boolean(item.localPath));
            const songLocOpen = localizeFormOpen().open && localizeFormOpen().scope === 'song' && localizeFormOpen().key === item.id;
            const songLocalizeSection = canLocalizeSong ? `<div class="audioflix-info-groups" style="margin-top:10px;"><button type="button" class="audioflix-add-toggle${songLocOpen ? ' is-active' : ''}" data-af-action="toggle-localize-form" data-af-scope="song" data-af-key="${esc(item.id)}">${item.localPath ? '⬇️ Re-localize this track' : '⬇️ Localize this track'}</button>${songLocOpen ? renderLocalizeForm() : ''}</div>` : '';
            const storedKey = type === 'music' ? 'music' : 'soundboard';
            const canDelete = (state()[storedKey] || []).some((entry) => entry.id === item.id);
            const confirmingDelete = canDelete && deleteConfirmId() === item.id;
            const deleteAction = confirmingDelete
                ? `<div class="audioflix-delete-confirm"><span>Remove this ${type === 'music' ? 'track' : 'sound'} from Audioflix? The source file on disk is not deleted.</span><button type="button" data-af-action="confirm-delete-item" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}">Delete</button><button type="button" data-af-action="cancel-delete-item" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}">Cancel</button></div>`
                : (canDelete
                    ? `<button type="button" class="audioflix-info-close-action audioflix-delete-item-action" data-af-action="delete-item" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}">Delete from Audioflix</button>`
                    : (item.isPorted && type === 'sound' ? '<span class="audioflix-settings-hint">Port-managed sound: remove or disconnect its source folder to remove it.</span>' : ''));

            return `<div class="audioflix-info-modal" data-af-action="close-info"><div class="audioflix-info-card"><div class="audioflix-info-header"><div><span class="audioflix-kicker">${type === 'music' ? 'Track Details' : 'Sound Details'}</span><h3 class="audioflix-info-title">${esc(item.title)}</h3></div><button type="button" class="audioflix-info-close-btn" data-af-action="close-info">${closeSvg}</button></div><div class="audioflix-info-body">${row('Type', type)}${row('Source', src)}${row('Duration', dur)}${item.artist ? row('Artist', item.artist) : ''}${creatorRow}${audioRow}${item.volume !== undefined ? row('Volume modifier', item.volume) : ''}${exposeRow}${spotifyTransportRow}${hotkeyRow}${repeaterBlock}${dupSection}${renderGroupAssign(item, type)}${trackEditBlock}<div class="audioflix-info-url-container"><span>Audio URL / Path</span><div class="audioflix-info-url-row"><input type="text" readonly value="${esc(item.url)}" class="audioflix-info-url-input" onclick="this.select()"><button type="button" class="audioflix-info-copy-btn" data-af-action="copy-url" data-af-url="${esc(item.url)}">Copy</button></div></div>${(type === 'music' ? uiLoc.renderSongLocalizations(item) : '') || localSourceRow}${provenanceSection}${localHealthSection}${offlineRow}${type === 'music' ? uiClass.renderSongSection(item) : ''}${songLocalizeSection}</div><div class="audioflix-info-footer">${deleteAction}${internalViewButton(item, type, true)}<button type="button" class="audioflix-info-close-action" data-af-action="close-info">Close</button></div></div></div>`;
        };
        const renderGroupAssign = (item, type = 'sound', mine = new Set(groupsOf(item.id, type))) => `<div class="audioflix-info-groups"><span class="audioflix-info-groups-label">Frontend Groups</span><div class="audioflix-group-checklist">${allGroups(type).map(g => `<label class="audioflix-group-check"><input type="checkbox" class="audioflix-group-cb" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}" data-af-group="${esc(g)}" ${mine.has(g) ? 'checked' : ''}><span>${esc(g)}</span></label>`).join('') || '<span class="audioflix-group-empty">No groups yet — create one below.</span>'}</div><form class="audioflix-group-quick" data-af-form="assign-new-group" data-af-type="${esc(type)}" data-af-id="${esc(item.id)}"><input name="name" placeholder="New group" autocomplete="off" maxlength="40"><button type="submit" data-af-action="submit-form">Add</button></form></div>`;

        return { renderInfoModal, renderGroupAssign };
    };

    ns.ready = true;
})();
