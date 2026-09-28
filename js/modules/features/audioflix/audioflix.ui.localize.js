// Localization UI renderers for the Audioflix music library. Split out of audioflix.ui.js to keep
// that view under the line cap and to house the growing localization surface: the collapsible
// localize form (with the group class-mode selector), the music-port extract form, a group's
// "connected paths" popover (1st-class folder files + the group's own files/shortcuts), and the
// per-track localization list shown in the settings panel (folder > shortcut > group-dup order).
window.EveAudioflixUiLocalize = window.EveAudioflixUiLocalize || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixUiLocalize;
    if (ns.ready) return;

    ns.create = function create(deps) {
        const esc = deps.esc;
        const findItem = deps.findItem;
        const getLoc = deps.getLocalizeFormOpen;       // () -> { open, scope, key }
        const getMissing = deps.getMissingListOpen;    // () -> { open, scope, key }
        const getPaths = deps.getGroupPathsOpen;       // () -> { open, key }
        const L = () => window.EveAudioflixLocalize;

        function renderLocalizeForm() {
            const lo = getLoc();
            const scope = lo.scope || 'library';
            const key = lo.key || '';
            const api = L();
            const stats = api?.scopeStats?.(scope, key) || { online: 0, notLocal: 0, alreadyLocal: 0, missingLocal: 0 };
            const lastDir = api?.getScopeDir?.(scope, key) || api?.lastDir?.() || '';
            const scopeLabel = scope === 'library' ? 'Entire Music Library'
                : scope === 'group' ? `Group "${key}"`
                    : scope === 'folder' ? `Folder "${key}"`
                        : `Track "${(findItem('music', key) || {}).title || ''}"`;
            const forceOnly = stats.notLocal === 0 && stats.alreadyLocal > 0;
            const canRun = stats.notLocal > 0 || stats.alreadyLocal > 0 || scope === 'group';
            const count = forceOnly ? stats.alreadyLocal : stats.notLocal;
            const forceField = forceOnly
                ? `<input type="hidden" name="force" value="1">`
                : (stats.alreadyLocal > 0
                    ? `<label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; color:#cbd5e1; margin-top:6px;"><input type="checkbox" name="force" value="1"> Also re-download ${stats.alreadyLocal} already-local (refresh deleted copies)</label>`
                    : '');
            const modeField = scope === 'group'
                ? `<label style="display:flex; flex-direction:column; gap:2px; font-size:0.8rem; color:#cbd5e1; margin-top:4px;"><span>Group localization mode</span><select name="mode" style="padding:4px 6px; border-radius:8px;"><option value="link">Reuse — folder copies stay 1st; already-local songs get a shortcut (no duplicate files)</option><option value="smart">Fresh — folder copies stay 1st; every other song downloads into this group's path</option><option value="dup">Duplicate — own copy of every song here (track keeps both physical paths)</option></select></label>`
                : '';
            const formatField = `<label style="display:flex; flex-direction:column; gap:2px; font-size:0.8rem; color:#cbd5e1;"><span>Saved media</span><select name="mediaFormat"><option value="audio">Music audio (MP3 when ffmpeg is available)</option><option value="video">Source video (MP4 for YouTube or Instagram)</option></select></label>`;
            const btnLabel = forceOnly ? `Re-localize (${count})` : (scope === 'group' ? 'Localize Group' : `Start Localizing (${count})`);
            const note = (canRun || scope === 'group')
                ? `${scopeLabel} — ${stats.notLocal} new${stats.alreadyLocal ? `, ${stats.alreadyLocal} already local` : ''}`
                : `${scopeLabel} — nothing to localize (no online tracks).`;
            const mo = getMissing();
            const isMissingOpen = mo.open && mo.scope === scope && mo.key === key;
            const missingTracks = (api?.collectScope?.(scope, key) || []).filter((it) => it.missingLocal === true);
            const missingListBlock = (isMissingOpen && missingTracks.length > 0) ? `<div class="audioflix-missing-tracks-box" style="margin-top:6px; padding:8px 10px; background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35); border-radius:8px; font-size:0.78rem; max-height:140px; overflow-y:auto;"><div style="font-weight:700; margin-bottom:4px; color:#f87171;">Missing Files (${missingTracks.length}):</div>${missingTracks.map((it) => `<div style="padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:space-between; gap:10px;"><strong style="color:#f8fafc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(it.title)}</strong><span style="color:#cbd5e1; font-family:monospace; font-size:0.72rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:55%;" title="${esc(it.localPath || '')}">${esc(it.localPath || '')}</span></div>`).join('')}</div>` : '';
            const missingWarning = stats.missingLocal > 0
                ? `<div style="margin-top:4px; color:#f87171; font-size:0.8rem; font-weight:600; display:flex; align-items:center; gap:8px;"><span>⚠️ ${stats.missingLocal} track file${stats.missingLocal === 1 ? '' : 's'} missing on disk (deleted). Ready to re-download.</span><button type="button" class="audioflix-add-toggle${isMissingOpen ? ' is-active' : ''}" data-af-action="toggle-missing-list" data-af-scope="${esc(scope)}" data-af-key="${esc(key)}" style="background:rgba(248,113,113,0.18); color:#f87171; border:1px solid rgba(248,113,113,0.4); font-size:0.75rem; padding:2px 8px; border-radius:12px; white-space:nowrap; cursor:pointer;" title="View list of missing track names">📋 ${isMissingOpen ? 'Hide Missing' : 'View Missing'}</button></div>${missingListBlock}`
                : '';
            const btnStyle = `font-size:0.8rem; padding:5px 12px; height:32px; white-space:nowrap; border-radius:16px;`;
            const auditBtn = `<button type="button" class="audioflix-add-toggle" data-af-action="audit-scope-disk" data-af-scope="${esc(scope)}" data-af-key="${esc(key)}" style="${btnStyle} background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.35);" title="Scan the folder on PC to check if files were deleted outside EveOS">🔍 Verify Files</button>`;
            const recalibrateBtn = `<button type="button" class="audioflix-add-toggle" data-af-action="recalibrate-scope-path" data-af-scope="${esc(scope)}" data-af-key="${esc(key)}" style="${btnStyle} background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.35);" title="Re-link local files to this path without re-downloading">🔄 Recalibrate Path</button>`;

            // Scope-level Music Port status & management
            const fsFolders = deps.getFsPortFolders?.() || [];
            const searchKey = String(key || 'Audioflix Music').toLowerCase();
            const matchedPort = fsFolders.find((f) => String(f.nickname || '').toLowerCase() === searchKey || String(f.rootName || '').toLowerCase() === searchKey);
            let portStatusBadge = '';
            let grantBtn = '';
            if (matchedPort) {
                const isGranted = matchedPort.permission === 'granted';
                const statusLabel = isGranted ? '🟢 Granted (browser access active)' : '⚠️ Needs Reconnect (click to grant access)';
                const statusColor = isGranted ? '#4ade80' : '#fbbf24';
                const statusBg = isGranted ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)';
                const statusBorder = isGranted ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)';
                portStatusBadge = `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; padding:6px 10px; background:${statusBg}; border:1px solid ${statusBorder}; border-radius:8px; font-size:0.78rem; box-sizing:border-box;"><span style="color:${statusColor}; font-weight:600;">${statusLabel}</span><div style="display:flex; align-items:center; gap:6px;"><button type="button" class="audioflix-add-toggle" data-af-action="regrant-music-folder" data-af-scope="${esc(scope)}" data-af-key="${esc(key)}" data-af-id="${esc(matchedPort.id)}" style="font-size:0.72rem; padding:2px 8px;">${isGranted ? 'Re-grant' : 'Reconnect'}</button><button type="button" class="audioflix-icon-btn danger" data-af-action="remove-music-fsport" data-af-id="${esc(matchedPort.id)}" style="font-size:0.72rem;" title="Disconnect music folder access">${deps.closeSvg || '✕'}</button></div></div>`;
            } else {
                grantBtn = `<button type="button" class="audioflix-add-toggle" data-af-action="grant-localize-folder" data-af-scope="${esc(scope)}" data-af-key="${esc(key)}" data-af-nickname="${esc(key || 'Audioflix Music')}" style="${btnStyle}" title="Grant this folder so EveOS can verify and play it without localhost">Grant File Access</button>`;
            }

            return `<form class="audioflix-form audioflix-localize-panel-form" data-af-form="localize-form" data-af-scope="${esc(scope)}" data-af-key="${esc(key)}" style="display:flex; flex-direction:column; gap:8px; padding:12px; border-radius:12px; background:rgba(0,0,0,0.25);">
                <label class="audioflix-wide-field" style="width:100%;"><span>Target Local Folder Path (on PC)</span><input name="targetDir" required value="${esc(lastDir)}" placeholder="e.g. C:\\Music\\EveOS or /home/you/Music" style="width:100%; box-sizing:border-box;"></label>
                ${modeField}
                ${formatField}
                ${forceField}
                ${missingWarning}
                ${portStatusBadge}
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:4px;">
                    <button type="submit" data-af-action="submit-form" ${canRun ? '' : 'disabled'} style="${btnStyle}">${btnLabel}</button>
                    ${recalibrateBtn}
                    ${auditBtn}
                    ${grantBtn}
                </div>
                <div style="font-size:0.78rem; color:#94a3b8; font-weight:500; margin-top:2px;">${esc(note)}</div>
            </form>`;
        }

        function renderMusicPortForm() {
            const lastDir = L()?.lastDir?.() || '';
            const snapshot = window.EveAudioflixState?.ensure?.() || {};
            const music = snapshot.music || [];
            const connections = snapshot.musicPortConnections || [];
            const fsFolders = (deps.getFsPortFolders?.() || []).filter((f) => f.purpose === 'music');
            const closeBtn = deps.closeSvg || '✕';
            const P = window.EveAudioflixPaths;
            const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
            const trackClaims = (track) => [track.localPath, ...(track.localizations || []).map((entry) => entry.path)].filter(Boolean);
            const coveredBy = (track, folder) => trackClaims(track).some((claim) => {
                if (String(claim).startsWith(`fsport://${folder.id}/`)) return true;
                const root = folder.rootName || folder.nickname || '';
                return !!root && (P?.relativeAfterFolder?.(claim, root) || []).length > 0;
            });
            const stats = L()?.scopeStats?.('library', '') || { online: 0, notLocal: 0, alreadyLocal: 0, missingLocal: 0 };
            const summary = `<div class="audioflix-port-health-summary"><strong>Music local health</strong><span>${stats.alreadyLocal} localized/ported · ${stats.missingLocal} missing · ${stats.notLocal} need a local copy</span><button type="button" class="audioflix-add-toggle" data-af-action="audit-scope-disk" data-af-scope="library" data-af-key="">Verify all local files</button></div>`;

            const connectionRows = connections.map((conn) => {
                const tracks = music.filter((track) => (
                    same(track.folder || track.card, conn.folder)
                    && (track.isMusicPort || (track.localizations || []).some((entry) => same(entry.source, `folder:${conn.folder}`)))
                ));
                const missing = tracks.filter((track) => track.missingLocal === true).length;
                const local = tracks.filter((track) => !!track.localPath).length;
                const browser = fsFolders.find((folder) => folder.id === conn.browserFolderId);
                const connected = browser?.permission === 'granted';
                const statusColor = missing ? '#f87171' : connected ? '#7ee2a8' : '#f2b96b';
                const source = conn.path || conn.browserRootName || '(folder path unavailable)';
                const browserAction = browser
                    ? `<button type="button" class="audioflix-add-toggle" data-af-action="regrant-music-folder" data-af-id="${esc(browser.id)}" data-af-nickname="${esc(browser.nickname || conn.folder)}">${connected ? 'Re-grant' : 'Reconnect'}</button>`
                    : `<button type="button" class="audioflix-add-toggle" data-af-action="grant-localize-folder" data-af-scope="folder" data-af-key="${esc(conn.folder)}" data-af-nickname="${esc(conn.browserRootName || conn.folder)}">Grant Folder</button>`;
                return `<div class="audioflix-port-item audioflix-music-port-track-row"><div><strong>${esc(conn.folder || 'Music Port')}</strong><code style="display:block;font-size:0.78rem;color:#8ab4f8;word-break:break-all;">${esc(source)}</code><code style="display:block;font-size:0.78rem;color:${statusColor};">${tracks.length} tracked · ${local} local · ${missing} missing${connected ? ' · browser access live' : ''}</code></div><button type="button" class="audioflix-add-toggle" data-af-action="sync-music-port-folder" data-af-folder="${esc(conn.folder)}">Sync</button><button type="button" class="audioflix-add-toggle" data-af-action="audit-scope-disk" data-af-scope="folder" data-af-key="${esc(conn.folder)}">Verify</button>${browserAction}</div>`;
            }).join('');

            const connectedIds = new Set(connections.map((conn) => conn.browserFolderId).filter(Boolean));
            const standaloneRows = fsFolders.filter((folder) => !connectedIds.has(folder.id)).map((folder) => {
                const granted = folder.permission === 'granted';
                const covered = music.filter((track) => coveredBy(track, folder));
                const missing = covered.filter((track) => track.missingLocal === true).length;
                return `<div class="audioflix-port-item"><div><strong>${esc(folder.nickname)}</strong><code style="display:block;font-size:0.8rem;color:${granted ? '#7ee2a8' : '#f2b96b'};">${granted ? 'Connected (browser access)' : 'Needs reconnect'} · ${covered.length} linked track${covered.length === 1 ? '' : 's'}${missing ? ` · ${missing} missing` : ''}</code></div><button type="button" class="audioflix-add-toggle" data-af-action="regrant-music-folder" data-af-id="${esc(folder.id)}" data-af-nickname="${esc(folder.nickname)}">${granted ? 'Re-grant' : 'Reconnect'}</button><button type="button" class="audioflix-icon-btn danger" data-af-action="remove-music-fsport" data-af-id="${esc(folder.id)}">${closeBtn}</button></div>`;
            }).join('');
            const trackerRows = connectionRows || standaloneRows
                ? `${connectionRows}${standaloneRows}`
                : '<div class="audioflix-empty" style="margin-bottom:8px;">No music folders tracked yet. Import a Music Port or grant a localization folder below.</div>';

            return `<div class="audioflix-ports-mgr audioflix-music-port-tracker" style="margin-bottom:12px;"><h4>Music Port Tracker <span style="font-weight:normal;font-size:0.78rem;color:#9aa8bd;">(ported + localized folders, missing-file health, offline grants)</span></h4>${summary}${trackerRows}</div><form class="audioflix-form" data-af-form="music-port-form">
                <label class="audioflix-wide-field"><span>Local Folder Path (optional when browsing)</span><input name="path" value="${esc(lastDir)}" placeholder="C:\\path\\to\\music\\folder"></label>
                <label><span>Target Folder Tag Name</span><input name="folder" placeholder="Ported Music"></label>
                <button type="submit" data-af-action="submit-form">Extract Music</button>
                <p class="audioflix-settings-hint" style="grid-column:1/-1; margin:6px 0 0;">With localhost running, a typed path is scanned directly. With localhost off, leave the path blank and press Extract Music: Edge/Chrome opens a folder picker, recursively imports nested songs, and keeps that folder tied to Music Library health checks.</p>
            </form>`;
        }

        // A group's connected localization paths: 1st-class folder files of its members, and the
        // group's own files/shortcuts. Shown alongside the group's main path, not replacing it.
        function renderGroupPaths(groupKey) {
            const po = getPaths();
            if (!po.open || po.key !== groupKey) return '';
            const data = L()?.groupLocalizationPaths?.(groupKey) || { firstClass: [], groupPaths: [], inheritedPaths: [], memberCount: 0, uncoveredCount: 0, groupDir: '' };
            const scopesOpen = deps.getGroupPathsScopesOpen?.() || {};
            const groupScopes = scopesOpen[groupKey] || { first: false, group: false };
            const row = (label, path, tag, color) => `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.06);"><span style="color:#f8fafc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(label)} <em style="color:${color}; font-style:normal; font-size:0.7rem;">${tag}</em></span><span style="color:#cbd5e1; font-family:monospace; font-size:0.7rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:52%;" title="${esc(path)}">${esc(path)}</span></div>`;
            const firstRows = data.firstClass.map((e) => row(e.title, e.path, `1st · folder ${e.source}`, '#38bdf8')).join('');
            const grpRows = data.groupPaths.map((e) => row(e.title, e.path, e.kind === 'shortcut' ? '3rd · shortcut' : '2nd · group', e.kind === 'shortcut' ? '#c084fc' : '#34d399')).join('');
            const inheritedRows = (data.inheritedPaths || []).map((e) => row(e.title, e.path, 'shared · another scope', '#f59e0b')).join('');
            const firstHeader = `<button type="button" class="audioflix-add-toggle${groupScopes.first ? ' is-active' : ''}" data-af-action="toggle-group-paths-scope" data-af-group="${esc(groupKey)}" data-af-scope="first" style="font-size:0.72rem; padding:2px 8px; border-radius:10px; cursor:pointer; margin-top:4px;">${groupScopes.first ? '▲' : '▼'} 1st class (folder) (${data.firstClass.length})</button>`;
            const grpHeader = `<button type="button" class="audioflix-add-toggle${groupScopes.group ? ' is-active' : ''}" data-af-action="toggle-group-paths-scope" data-af-group="${esc(groupKey)}" data-af-scope="group" style="font-size:0.72rem; padding:2px 8px; border-radius:10px; cursor:pointer; margin-top:4px;">${groupScopes.group ? '▲' : '▼'} Group (2nd class / shortcuts) (${data.groupPaths.length})</button>`;
            const firstBlock = data.firstClass.length ? `<div style="margin-top:4px;">${firstHeader}${groupScopes.first ? `<div style="margin-top:2px;">${firstRows}</div>` : ''}</div>` : '';
            const grpBlock = data.groupPaths.length ? `<div style="margin-top:4px;">${grpHeader}${groupScopes.group ? `<div style="margin-top:2px;">${grpRows}</div>` : ''}</div>` : '';
            const inheritedBlock = inheritedRows ? `<div style="margin-top:6px;"><strong style="color:#f59e0b;">Shared from another scope (${data.inheritedPaths.length})</strong>${inheritedRows}</div>` : '';
            const coverage = `${data.memberCount || 0} member track${data.memberCount === 1 ? '' : 's'} · ${data.uncoveredCount || 0} without a local path`;
            const body = `${firstBlock}${grpBlock}${inheritedBlock}` || '<div style="color:#94a3b8; margin-top:4px;">No localizations connected to this group yet.</div>';
            return `<div class="audioflix-group-paths-box" style="margin-top:6px; padding:8px 10px; background:rgba(15,23,42,0.5); border:1px solid rgba(148,163,184,0.25); border-radius:8px; font-size:0.78rem;"><div style="font-weight:700; margin-bottom:2px; color:#93c5fd;">Connected Paths — group dir: <span style="font-family:monospace; color:#cbd5e1;">${esc(data.groupDir || '(none)')}</span></div><div style="color:#94a3b8; margin-bottom:4px;">${coverage}</div>${body}</div>`;
        }

        // The track settings panel's localization list, most-important class first. Each path is an
        // EDITABLE input (hover shows the full path via title=) so a wrong entry can be corrected in
        // place; a shortcut also shows the physical file it points at, since that is the real bytes.
        function renderSongLocalizations(track) {
            const list = L()?.songLocalizationList?.(track) || [];
            if (!list.length) return '';
            const color = (kind, label) => label.startsWith('Folder') ? '#38bdf8' : kind === 'shortcut' ? '#c084fc' : '#34d399';
            const rows = list.map((e, i) => {
                const linkNote = e.kind === 'shortcut' && e.linkOf
                    ? `<div style="font-size:0.68rem; color:#94a3b8; margin-top:2px;" title="${esc(e.linkOf)}">↳ real file: <code style="color:#cbd5e1;">${esc(e.linkOf)}</code></div>`
                    : '';
                return `<div style="padding:4px 0; ${i ? 'border-top:1px solid rgba(255,255,255,0.06);' : ''}"><div style="display:flex; align-items:center; gap:8px;"><span style="color:${color(e.kind, e.label)}; font-weight:600; white-space:nowrap; font-size:0.78rem;">${i === 0 ? '★ ' : ''}${esc(e.label)}</span><input type="text" class="audioflix-info-url-input audioflix-localization-path" data-af-id="${esc(track.id)}" data-af-source="${esc(e.source || '')}" value="${esc(e.path)}" title="${esc(e.path)}" style="flex:1; min-width:0; font-family:monospace; font-size:0.72rem;"></div>${linkNote}</div>`;
            }).join('');
            return `<div class="audioflix-info-url-container"><span>Localizations (★ = plays first · hover or edit a path)</span><div style="padding:6px 10px; background:rgba(0,0,0,0.25); border-radius:8px;">${rows}</div></div>`;
        }

        return { renderLocalizeForm, renderMusicPortForm, renderGroupPaths, renderSongLocalizations };
    };

    ns.ready = true;
})();
