// Spotify-specific playlist inspector and actions. Kept separate from the generic group manager so
// provider UI can evolve without coupling YouTube/WPL rendering to Spotify's saved-session flow.
window.EveAudioflixSpotifyUi = window.EveAudioflixSpotifyUi || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyUi;
    if (ns.ready) return;

    function renderLinkForm(groupName, connection, ctx) {
        const { esc, state } = ctx;
        const extraction = String(connection.scrapeSource || '').startsWith('embed')
            ? 'Spotify embed extraction' : 'Spotify saved-session extraction';
        const tracks = (state().music || [])
            .filter((track) => track.playlistId === connection.id)
            .sort((a, b) => Number(a.playlistPosition || 0) - Number(b.playlistPosition || 0));
        const rows = tracks.map((track, index) => {
            const search = [track.title, track.artist, track.album].join(' ').toLowerCase();
            return `<div class="audioflix-spotify-row" data-af-spotify-row data-af-search="${esc(search)}">
                <span class="audioflix-spotify-index">${index + 1}</span>
                ${track.image ? `<img src="${esc(track.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="audioflix-spotify-art">&#9834;</span>'}
                <span><strong>${esc(track.title)}</strong><small>${esc([track.artist, track.album].filter(Boolean).join(' / ') || 'Spotify track')}</small></span>
                <time>${track.duration ? formatDuration(track.duration) : ''}</time>
            </div>`;
        }).join('');
        return `<section class="audioflix-spotify-inspector" data-af-spotify-inspector>
            <header>
                ${connection.image ? `<img src="${esc(connection.image)}" alt="" referrerpolicy="no-referrer">` : '<span class="audioflix-spotify-cover">&#9835;</span>'}
                <div><span class="audioflix-spotify-kicker">${extraction}</span>
                    <h5>${esc(connection.title || groupName)}</h5>
                    <p>${esc(connection.owner || 'Playlist owner unavailable')} / ${tracks.length} imported track${tracks.length === 1 ? '' : 's'}</p>
                </div>
            </header>
            <form class="audioflix-form audioflix-spotify-link-form" data-af-form="playlist-link-form" data-af-group="${esc(groupName)}">
                <label class="audioflix-wide-field"><span>Playlist URL, embed URL, or iframe</span>
                    <textarea name="link" rows="2" required>${esc(connection.url || connection.embedUrl || '')}</textarea>
                </label>
                <button type="submit" data-af-action="submit-form">Save Source</button>
                <button type="button" data-af-action="spotify-sync" data-af-group="${esc(groupName)}">Scrape Again</button>
                <button type="button" data-af-action="spotify-session" data-af-group="${esc(groupName)}">Open Saved Session</button>
                <button type="button" data-af-action="spotify-open" data-af-url="${esc(connection.url)}">Open Spotify</button>
                <button type="button" data-af-action="toggle-playlist-link-form" data-af-group="${esc(groupName)}">Close</button>
            </form>
            <label class="audioflix-spotify-search"><span>Search imported songs</span><input type="search" data-af-spotify-search placeholder="Title, artist, or album"></label>
            <div class="audioflix-spotify-list">${rows || '<div class="audioflix-empty">No imported Spotify tracks yet.</div>'}</div>
        </section>`;
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Math.round(Number(seconds) || 0));
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    function createActions(ctx) {
        return async function handleSpotifyAction(target, action) {
            if (!['spotify-session', 'spotify-session-import', 'spotify-sync', 'spotify-open'].includes(action)) return false;
            if (action === 'spotify-open') {
                const url = target.dataset.afUrl;
                if (url) window.open(url, '_blank', 'noopener');
                return true;
            }
            const group = target.dataset.afGroup || '';
            const connection = group ? window.EveAudioflixPlaylists?.getPlaylistForGroup?.(group) : null;
            const importForm = target.closest('form');
            const importValue = importForm?.querySelector('[name="url"]')?.value || '';
            const importFolder = importForm?.querySelector('[name="folder"]')?.value || '';
            const source = connection?.url || importValue;
            if (!source) {
                ctx.playbackStatus = 'Enter a Spotify playlist URL or iframe first.';
                ctx.rerender();
                return true;
            }
            if (action === 'spotify-session' || action === 'spotify-session-import') {
                ctx.playbackStatus = 'Opening the saved Spotify session...';
                if (action === 'spotify-session-import') {
                    ctx.importFormValues = Object.assign({}, ctx.importFormValues, {
                        spotifyUrl: source,
                        spotifyFolder: importFolder,
                        spotifyStatus: ctx.playbackStatus
                    });
                }
                ctx.rerender();
                const result = await window.EveAudioflixSpotify?.openSession?.(source);
                ctx.playbackStatus = result?.ok ? result.message : (result?.reason || result?.message || 'Could not open Spotify session.');
                if (action === 'spotify-session-import') {
                    ctx.importFormValues = Object.assign({}, ctx.importFormValues, {
                        spotifyStatus: ctx.playbackStatus
                    });
                }
                ctx.rerender();
                return true;
            }
            ctx.playbackStatus = `Refreshing Spotify playlist "${group}"...`;
            ctx.rerender();
            const result = await window.EveAudioflixPlaylists?.syncPlaylistByGroup?.(group, true);
            ctx.playbackStatus = result?.ok
                ? `Spotify playlist refreshed: ${result.added || 0} added, ${result.restored || 0} restored, ${result.missing || 0} no longer upstream.`
                : (result?.reason || 'Spotify extraction failed.');
            ctx.rerender();
            return true;
        };
    }

    Object.assign(ns, { ready: true, renderLinkForm, createActions });
})();
