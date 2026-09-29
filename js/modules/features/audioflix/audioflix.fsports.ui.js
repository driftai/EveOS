// Presentation only; folder grants, handles, and lifecycle stay in the port runtime.
window.EveAudioflixFsPortsUi = window.EveAudioflixFsPortsUi || {};
(function (ui) {
    'use strict';
    function renderPortsManager(fsSupported, state, fsPortFolders, deadServerPorts, esc, closeSvg) {
        const ports = state.ports || [];
        const fsById = new Map(fsPortFolders.map(f => [f.id, f]));
        // Server ports can be "recalibrated": granting their folder stores the handle under the
        // PORT's id, so the port itself loads serverless with every per-item setting intact.
        const serverRows = ports.map(p => {
            const link = fsById.get(p.id);
            const status = link
                ? `<code style="display: block; font-size: 0.78rem; color: ${link.permission === 'granted' ? '#7ee2a8' : '#f2b96b'};">${link.permission === 'granted' ? 'Linked — loads without the server (browser access)' : 'Linked — needs reconnect'}</code>`
                : (deadServerPorts.has(p.id) ? '<code style="display: block; font-size: 0.78rem; color: #f2b96b;">Not loaded — server offline. Grant Folder to load it without the server.</code>' : '');
            const grantBtn = fsSupported ? `<button type="button" class="audioflix-add-toggle" data-af-action="link-fsport" data-af-id="${esc(p.id)}" data-af-nickname="${esc(p.nickname)}" style="margin-right: 6px; flex: 0 0 auto;">${link ? 'Re-grant' : 'Grant Folder'}</button>` : '';
            return `<div class="audioflix-port-item"><div><strong>${esc(p.nickname)}</strong><code style="display: block; font-size: 0.8rem; color: #8ab4f8;">${esc(p.path)}</code>${status}</div>${grantBtn}<button type="button" class="audioflix-icon-btn danger" data-af-action="remove-port" data-af-id="${esc(p.id)}">${closeSvg}</button></div>`;
        }).join('') || '<div class="audioflix-empty">No ports configured.</div>';
        // Standalone Browser Folders (not linked to a port): granted-handle sources that need NO
        // server (work on file://). Filter out folders granted specifically for Music Library tracks.
        const standalone = fsPortFolders.filter(f => f.purpose !== 'music' && !ports.some(p => p.id === f.id));
        const pendingCount = fsPortFolders.filter(f => f.permission !== 'granted').length;
        // A non-granted standalone folder (browser-downgraded permission OR a restored backup stub)
        // gets a per-folder Re-grant that re-selects the folder under the same id, so its per-item
        // settings return once reconnected.
        const fsRows = standalone.map(f => {
            // Save path is offered ALWAYS (including on file:// where the folder is happily
            // granted): typing the path once makes it a Port whose path rides in the backup, so a
            // restore on localhost is ready to go. A granted folder KEEPS its handle, so the same
            // entry still loads serverless here — server-dependent on localhost, file:// adaptable.
            // Re-grant only appears when the handle is missing/downgraded and must be re-picked.
            const granted = f.permission === 'granted';
            const btn = (act, label) => `<button type="button" class="audioflix-add-toggle" data-af-action="${act}" data-af-id="${esc(f.id)}" data-af-nickname="${esc(f.nickname)}" data-af-granted="${granted ? '1' : '0'}" style="margin-right: 6px; flex: 0 0 auto;">${label}</button>`;
            const actions = fsSupported
                ? `${btn('portify-fsport', 'Save path')}${granted ? '' : btn('regrant-fsport', 'Re-grant')}`
                : '';
            return `<div class="audioflix-port-item"><div><strong>${esc(f.nickname)}</strong><code style="display: block; font-size: 0.8rem; color: ${f.permission === 'granted' ? '#7ee2a8' : '#f2b96b'};">${f.permission === 'granted' ? 'Connected (browser access)' : 'Needs reconnect'}</code></div>${actions}<button type="button" class="audioflix-icon-btn danger" data-af-action="remove-fsport" data-af-id="${esc(f.id)}">${closeSvg}</button></div>`;
        }).join('') || '<div class="audioflix-empty">No standalone browser folders. Use a port row\'s Grant Folder to link it, or grant a new folder here.</div>';
        const fsSection = fsSupported
            ? `<h4 style="margin-top: 14px;">Browser Folders <span style="font-weight: normal; font-size: 0.78rem; color: #9aa8bd;">(no server needed — works on file://)</span></h4>${fsRows}<div style="display: flex; gap: 8px; margin-top: 8px;"><button type="button" class="audioflix-add-toggle" data-af-action="add-fsport">Grant Folder</button>${pendingCount ? `<button type="button" class="audioflix-add-toggle" data-af-action="reconnect-fsports">Reconnect ${pendingCount} folder${pendingCount === 1 ? '' : 's'}</button>` : ''}</div>`
            : '';
        return `<div class="audioflix-ports-mgr"><h4>Soundboard Ports</h4>${serverRows}<form class="audioflix-ports-form" data-af-form="add-port"><label><span>Nickname</span><input name="nickname" required></label><label><span>Directory Path</span><input name="path" required></label><button type="submit" data-af-action="submit-form">Add Port</button></form>${fsSection}</div>`;
    }
    ui.renderPortsManager = renderPortsManager;
})(window.EveAudioflixFsPortsUi);
