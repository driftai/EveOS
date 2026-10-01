// Groups + Folders manager panels for the Audioflix music/soundboard toolbars (rename, delete, the
// localize entry point, playlist sync and the connected-paths popover). Split out of audioflix.ui.js
// to keep that view under the project line cap; all helpers arrive late-bound through `ctx`.
window.EveAudioflixUiManagers = window.EveAudioflixUiManagers || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixUiManagers;
    if (ns.ready) return;

    ns.create = function create(ctx) {
        const { esc, closeSvg, state, allGroups, uiLoc } = ctx;
        const renderLocalizeForm = ctx.renderLocalizeForm;
        const renderSyncPlaylistForm = ctx.renderSyncPlaylistForm;
        const localizeFormOpen = ctx.getLocalizeFormOpen;
        const syncPlaylistFormOpen = ctx.getSyncPlaylistFormOpen;
        const groupPathsOpen = ctx.getGroupPathsOpen;
        const playlistLinkOpen = ctx.getPlaylistLinkOpen;

        // A saved playlist link goes stale (file renamed/moved, browser pick that only yielded a
        // bare filename), and a stale link is an unsyncable connection — so it is editable here.
        const renderPlaylistLinkForm = (g, conn) => {
            if (conn.provider === 'spotify') {
                return window.EveAudioflixSpotifyUi?.renderLinkForm?.(g, conn, { esc, state }) || '';
            }
            if (conn.provider === 'instagram') {
                return window.EveAudioflixInstagramUi?.renderLinkForm?.(g, conn, { esc, state }) || '';
            }
            const isWpl = conn.provider === 'wpl';
            const current = conn.url === 'wpl://local' ? '' : (conn.url || '');
            return `<form class="audioflix-form" data-af-form="playlist-link-form" data-af-group="${esc(g)}" style="margin-top:6px;"><label class="audioflix-wide-field"><span>${isWpl ? 'Linked .wpl file path' : 'Linked playlist URL'}</span><input name="link" value="${esc(current)}" placeholder="${isWpl ? 'C:\\path\\to\\playlist.wpl' : 'https://youtube.com/playlist?list=...'}" required></label><button type="submit" data-af-action="submit-form">Save Link</button><button type="button" class="audioflix-add-toggle" data-af-action="toggle-playlist-link-form" data-af-group="${esc(g)}" style="margin-left:8px;">Cancel</button></form>`;
        };

        const renderGroupsManager = (type = 'sound') => {
            const isM = type === 'music';
            const groups = allGroups(type);
            const snapshot = state();
            const map = isM ? (snapshot.musicGroupMap || {}) : (snapshot.soundGroupMap || {});
            const countFor = (g) => isM
                ? (snapshot.music || []).filter((item) => (
                    (map[item.id] || []).some((name) => String(name).toLowerCase() === String(g).toLowerCase())
                )).length
                : Object.values(map).filter((names) => Array.isArray(names) && names.includes(g)).length;
            const list = groups.map((g) => {
                const conn = isM ? window.EveAudioflixPlaylists?.getPlaylistForGroup?.(g) : null;
                // Own dir only — getScopeDir falls back to the last-used folder, which showed an
                // unrelated location as if this group were localized there.
                const dir = isM ? (window.EveAudioflixLocalize?.getScopeDirOwn?.('group', g) || '') : '';
                // Imported-playlist groups show BOTH the source URL and (if localized) the folder path.
                // A .wpl link is a disk path, not something an <a href> can open — show it as text.
                const isInstagram = conn?.provider === 'instagram';
                const isWebLink = !isInstagram && /^https?:\/\//i.test(conn?.url || '');
                const linkText = conn?.url && conn.url !== 'wpl://local' ? conn.url : '';
                const instagramCount = isInstagram ? String(linkText).split(/\r?\n/).filter(Boolean).length : 0;
                const linkLine = linkText
                    ? (isInstagram
                        ? `<div style="font-size:0.75rem; color:#f4a261; margin-top:2px;">${instagramCount} linked Instagram Reel${instagramCount === 1 ? '' : 's'}</div>`
                        : isWebLink
                        ? `<a href="${esc(linkText)}" target="_blank" rel="noopener" style="display:block; font-size:0.75rem; color:#8ab4f8; text-decoration:none; margin-top:2px; word-break:break-all;">${esc(linkText)}</a>`
                        : `<div style="font-size:0.75rem; color:#8ab4f8; margin-top:2px; word-break:break-all;">🔗 ${esc(linkText)}</div>`)
                    : (conn ? `<div style="font-size:0.75rem; color:#f59e0b; margin-top:2px;">🔗 No source link saved — sync needs one.</div>` : '');
                const urlLine = `${linkLine}${dir ? `<div style="font-size:0.75rem; color:#94a3b8; margin-top:2px;">📁 ${esc(dir)}</div>` : ''}`;
                const isLinkOpen = !!conn && playlistLinkOpen().open && playlistLinkOpen().group === g;
                const linkBtn = conn ? `<button type="button" class="audioflix-icon-btn${isLinkOpen ? ' is-active' : ''}" data-af-group="${esc(g)}" data-af-action="toggle-playlist-link-form" title="Edit the linked playlist URL / .wpl file path">🔗</button>` : '';
                const linkForm = isLinkOpen ? renderPlaylistLinkForm(g, conn) : '';
                const isSyncOpen = syncPlaylistFormOpen().open && syncPlaylistFormOpen().group === g;
                const syncBtn = conn ? `<button type="button" class="audioflix-icon-btn${isSyncOpen ? ' is-active' : ''}" data-af-group="${esc(g)}" data-af-action="toggle-sync-playlist-form" title="Sync this playlist">🔄</button>` : '';
                const dlBtn = isM ? `<button type="button" class="audioflix-icon-btn${localizeFormOpen().open && localizeFormOpen().scope === 'group' && localizeFormOpen().key === g ? ' is-active' : ''}" data-af-action="toggle-localize-form" data-af-scope="group" data-af-key="${esc(g)}" title="Localize this group's online tracks to local files">⬇️</button>` : '';
                const pathsBtn = isM ? `<button type="button" class="audioflix-icon-btn${groupPathsOpen().open && groupPathsOpen().key === g ? ' is-active' : ''}" data-af-action="toggle-group-paths" data-af-group="${esc(g)}" title="View all localization paths connected to this group">🗺️</button>` : '';
                const locForm = (isM && localizeFormOpen().open && localizeFormOpen().scope === 'group' && localizeFormOpen().key === g) ? renderLocalizeForm() : '';
                const syncForm = (isM && isSyncOpen) ? renderSyncPlaylistForm(g) : '';
                const pathsBox = isM ? uiLoc.renderGroupPaths(g) : '';
                return `<div class="audioflix-port-item"><div><strong>${esc(g)}</strong>${urlLine}<code style="display: block; font-size: 0.8rem; color: #94a3b8; margin-top:2px;">${countFor(g)} ${isM ? 'track' : 'sound'}${countFor(g) === 1 ? '' : 's'}</code></div><div style="display:flex; gap:6px;">${dlBtn}${pathsBtn}${linkBtn}${syncBtn}<button type="button" class="audioflix-icon-btn" data-af-type="${esc(type)}" data-af-group="${esc(g)}" data-af-action="rename-group-prompt" title="Edit group name or local path">✏️</button><button type="button" class="audioflix-icon-btn danger" data-af-type="${esc(type)}" data-af-group="${esc(g)}" data-af-action="remove-group" title="Delete group">${closeSvg}</button></div></div>${pathsBox}${locForm}${linkForm}${syncForm}`;
            }).join('') || '<div class="audioflix-empty">No groups yet.</div>';
            return `<div class="audioflix-ports-mgr"><h4>${isM ? 'Music Frontend Groups' : 'Soundboard Frontend Groups'}</h4>${list}<form class="audioflix-ports-form" data-af-form="add-group" data-af-type="${esc(type)}"><label><span>Group Name</span><input name="name" required maxlength="40"></label><button type="submit" data-af-action="submit-form">Add Group</button></form></div>`;
        };
        const renderFoldersManager = () => {
            const musicItems = state().music || [];
            const folderCounts = Object.fromEntries((state().musicFolders || []).map((name) => [String(name || '').trim(), 0]).filter(([name]) => name));
            musicItems.forEach(it => {
                const f = String(it.folder || it.card || '').trim() || 'Ungrouped';
                folderCounts[f] = (folderCounts[f] || 0) + 1;
            });
            const list = Object.entries(folderCounts).map(([f, count]) => {
                if (f === 'Ungrouped') return '';
                const conns = state().musicPortConnections || [];
                const conn = conns.find(c => c.folder === f);
                const dir = conn?.path || window.EveAudioflixLocalize?.getScopeDirOwn?.('folder', f) || '';
                const dirLine = dir ? `<div style="font-size:0.75rem; color:#94a3b8; margin-top:2px;">📁 ${esc(dir)}</div>` : '';
                const isLoc = localizeFormOpen().open && localizeFormOpen().scope === 'folder' && localizeFormOpen().key === f;
                const locForm = isLoc ? renderLocalizeForm() : '';
                const syncBtn = dir ? `<button type="button" class="audioflix-icon-btn" data-af-folder="${esc(f)}" data-af-action="sync-music-port-folder" title="Re-scan folder on disk for new or missing tracks">🔄</button>` : '';
                return `<div class="audioflix-port-item"><div><strong>${esc(f)}</strong>${dirLine}<code style="display: block; font-size: 0.8rem; color: #8ab4f8; margin-top:2px;">${count} track${count === 1 ? '' : 's'}</code></div><div style="display:flex; gap:6px;">${syncBtn}<button type="button" class="audioflix-icon-btn${isLoc ? ' is-active' : ''}" data-af-action="toggle-localize-form" data-af-scope="folder" data-af-key="${esc(f)}" title="Localize this folder's online tracks to local files">⬇️</button><button type="button" class="audioflix-icon-btn" data-af-folder="${esc(f)}" data-af-action="rename-folder-prompt" title="Edit folder name or local path">✏️</button><button type="button" class="audioflix-icon-btn danger" data-af-folder="${esc(f)}" data-af-action="delete-folder" title="Delete folder tag">${closeSvg}</button></div></div>${locForm}`;
            }).filter(Boolean).join('') || '<div class="audioflix-empty">No custom folders yet.</div>';
            return `<div class="audioflix-ports-mgr"><h4>Music Folders Manager</h4>${list}</div>`;
        };
        return { renderGroupsManager, renderFoldersManager };
    };

    ns.ready = true;
})();
