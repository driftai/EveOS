window.EveAudioflixPlaylistImportUi = window.EveAudioflixPlaylistImportUi || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixPlaylistImportUi;
    if (ns.ready) return;

    // Spotify's import form has one visible placement name. Mirror that folder into the hidden group
    // field so an imported folder is also the Audioflix group, instead of creating two unrelated
    // names for the same playlist. Other providers keep their existing independent placement rules.
    document.addEventListener('input', (event) => {
        const target = event.target;
        if (!target?.matches?.('form[data-af-form="import-playlist"][data-af-mode="spotify"] input[name="folder"]')) return;
        const group = target.form?.querySelector?.('input[name="group"]');
        if (group) group.value = target.value;
    });

    function modeSelector(mode) {
        const button = (value, label) => `<button type="button" class="audioflix-scope-pill${mode === value ? ' is-active' : ''}" data-af-action="select-playlist-mode" data-af-mode="${value}">${label}</button>`;
        return `<div class="audioflix-playlist-mode-row"><span>Import Mode:</span>${button('youtube', 'YouTube Playlist')}${button('wpl', 'WPL Playlist')}${button('spotify', 'Spotify Playlist')}${button('instagram', 'Instagram Videos')}</div>`;
    }

    function render({ mode = 'youtube', esc, values = {}, state = {} }) {
        const selector = modeSelector(mode);
        if (mode === 'wpl') {
            const urlValue = esc(values.wplUrl || '');
            return `<form class="audioflix-form" data-af-form="import-playlist" data-af-mode="wpl">${selector}<label class="audioflix-wide-field"><span>WPL Playlist File Path or Browse</span><div class="audioflix-inline-field"><input name="url" required placeholder="C:\\path\\to\\playlist.wpl" value="${urlValue}"><button type="button" class="audioflix-add-toggle" data-af-action="trigger-wpl-file-picker" title="Select .wpl file from your computer">Browse File</button></div></label><label><span>Target Folder</span><input name="folder" placeholder="WPL Playlists"></label><button type="submit" data-af-action="submit-form">Import WPL Playlist</button></form>`;
        }
        if (mode === 'spotify') {
            const urlValue = esc(values.spotifyUrl || '');
            const folderValue = esc(values.spotifyFolder || '');
            const status = esc(values.spotifyStatus || '');
            return `<form class="audioflix-form" data-af-form="import-playlist" data-af-mode="spotify">${selector}<label class="audioflix-wide-field"><span>Spotify playlist URL, embed URL, or iframe snippet</span><input name="url" required value="${urlValue}" placeholder="https://open.spotify.com/playlist/..." autocomplete="off" spellcheck="false"></label><label><span>Audioflix Folder / Group</span><input name="folder" value="${folderValue}" placeholder="Spotify Playlists"></label><input type="hidden" name="group" value="${folderValue}"><button type="submit" data-af-action="submit-form">Import Spotify Playlist</button><button type="button" data-af-action="spotify-session-import">Open Saved Session</button><small class="audioflix-wide-field">Private playlists use a separate saved EveOS Edge profile. Sign in there once; it does not share the login from your normal Edge window. Extraction needs a running local EveOS server.</small>${status ? `<output class="audioflix-import-status">${status}</output>` : ''}</form>`;
        }
        if (mode === 'instagram') {
            const urlValue = esc(values.instagramUrl || '');
            const groupValue = esc(values.instagramGroup || '');
            const folderValue = esc(values.instagramFolder || 'IG Video Playlists');
            const status = esc(values.instagramStatus || '');
            return `<form class="audioflix-form audioflix-instagram-import" data-af-form="import-playlist" data-af-mode="instagram">${selector}<label class="audioflix-wide-field"><span>Instagram video URLs or text collection</span><textarea name="url" rows="6" required placeholder="Paste one Instagram video URL per line">${urlValue}</textarea><small>Public Reel, post, and TV video links are supported. EveOS tries its public Instagram resolver first; no Instagram login, cookie export, or browser extension is required.</small></label><button type="button" data-af-action="instagram-collection-file">Choose .txt collection</button><label><span>Group title</span><input name="group" value="${groupValue}" required placeholder="Instagram Videos"></label><label><span>Audioflix Folder</span><input name="folder" value="${folderValue}" placeholder="IG Video Playlists"></label><button type="submit" data-af-action="submit-form">Import Video Collection</button>${status ? `<output class="audioflix-import-status">${status}</output>` : ''}</form>`;
        }
        const count = (state.musicPlaylists || []).filter((entry) => entry.provider !== 'wpl').length;
        const syncAll = count ? '<button type="button" class="audioflix-add-toggle" data-af-action="sync-all-playlists" title="Re-read all upstream playlists">Sync All Playlists</button>' : '';
        return `<form class="audioflix-form" data-af-form="import-playlist" data-af-mode="youtube">${selector}<label class="audioflix-wide-field"><span>Playlist URL</span><input name="url" required placeholder="https://youtube.com/playlist?list=..."></label><label><span>Target Folder</span><input name="folder" placeholder="Youtube Playlists"></label><button type="submit" data-af-action="submit-form">Import Playlist</button>${syncAll}</form>`;
    }

    Object.assign(ns, { ready: true, render });
})();