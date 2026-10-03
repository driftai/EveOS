// Form-submit handlers for the Audioflix panel (add track/sound/port/group, playlist import,
// localize, music port, classifiers, track edits). Split out of audioflix.ui.actions.js to keep that
// dispatcher under the project line cap. Shares the same `ctx` accessor bag as the dispatcher.
window.EveAudioflixUiForms = window.EveAudioflixUiForms || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixUiForms;
    if (ns.ready) return;

    ns.create = function create(ctx) {
            function handleForm(form) {
                const data = new FormData(form), fName = form.dataset.afForm, id = form.dataset.afId, type = form.dataset.afType;
                if (fName === 'add-port') { window.EveAudioflixState?.addPort?.({ nickname: data.get('nickname'), path: data.get('path') }); ctx.loadPortedSounds(); }
                else if (fName === 'add-group') {
                    if (type === 'music') window.EveAudioflixState?.addMusicGroup?.(data.get('name'), data.get('parent'));
                    else window.EveAudioflixState?.addSoundboardGroup?.(data.get('name'), data.get('parent'));
                    ctx.rerender();
                }
                else if (fName === 'assign-new-group') {
                    if (type === 'music') {
                        const group = data.get('name');
                        window.EveAudioflixState?.toggleMusicGroup?.(id, group, true);
                        window.EveAudioflix?.queueConnection?.syncGroupMembership?.(id, group, true);
                    } else window.EveAudioflixState?.toggleSoundGroup?.(id, data.get('name'), true);
                    ctx.pushHotkeysToBridge(); ctx.rerender();
                }
                else if (fName === 'import-playlist') {
                    const PL = window.EveAudioflixPlaylists;
                    const url = data.get('url'), folder = data.get('folder'), group = data.get('group');
                    const mode = form.dataset.afMode || ctx.playlistImportMode || 'youtube';
                    if (PL && url) {
                        if (mode === 'wpl') {
                            ctx.playbackStatus = 'Reading WPL playlist...'; ctx.rerender();
                            // Only reuse cached bytes when they came from the file being imported.
                            // Otherwise fall back to the path so the parser re-reads it — a name
                            // paired with another file's tracks is worse than an honest failure.
                            const base = (v) => String(v || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
                            const held = ctx.importFormValues || {};
                            const contentFits = held.wplFileContent && base(held.wplContentFor) === base(url);
                            const wplSource = contentFits ? held.wplFileContent : url;
                            PL.importWplPlaylist(wplSource, { folder: folder || '', wplPath: url }).then(res => {
                                ctx.playbackStatus = res.ok
                                    ? `Imported WPL Playlist "${res.group}" (${res.added} track${res.added === 1 ? '' : 's'}) into ${res.folder}.`
                                    : (res.reason || 'WPL import failed.');
                                if (res.ok) { ctx.importFormOpen = false; ctx.importFormValues = {}; delete form._wplFileContent; }
                                ctx.rerender();
                            });
                        } else {
                            ctx.importFormValues = Object.assign({}, ctx.importFormValues, {
                                [`${mode}Url`]: url || '',
                                [`${mode}Folder`]: folder || '',
                                [`${mode}Group`]: group || '',
                                [`${mode}Status`]: mode === 'spotify'
                                    ? 'Reading Spotify playlist through the saved local session...'
                                    : mode === 'instagram' ? 'Preparing Reel collection and enriching available metadata...'
                                    : 'Reading YouTube playlist...'
                            });
                            ctx.playbackStatus = ctx.importFormValues[`${mode}Status`];
                            ctx.rerender();
                            PL.importPlaylist(url, { folder: folder || '', group: group || '' }).then(res => {
                                ctx.playbackStatus = res.ok
                                    ? `Imported "${res.connection.title}" (${res.added} track${res.added === 1 ? '' : 's'}) into ${res.connection.folder}.`
                                    : (res.reason || 'Playlist import failed.');
                                if (res.ok) {
                                    ctx.importFormOpen = false;
                                    ctx.importFormValues = {};
                                } else {
                                    ctx.importFormValues = Object.assign({}, ctx.importFormValues, {
                                        [`${mode}Status`]: ctx.playbackStatus
                                    });
                                }
                                ctx.rerender();
                            });
                        }
                    }
                }
                else if (fName === 'sync-playlist-form') {
                    const groupName = form.dataset.afGroup;
                    const folder = data.get('folder');
                    const PL = window.EveAudioflixPlaylists;
                    if (PL && groupName) {
                        const conn = PL.getPlaylistForGroup(groupName);
                        const currentFolder = conn?.folder || 'Music';
                        const targetFolder = folder !== null ? String(folder).trim() : '';
                        ctx.playbackStatus = `Syncing playlist "${groupName}"...`;
                        ctx.syncPlaylistFormOpen = { open: false, group: '' };
                        ctx.rerender();
                        PL.syncPlaylistByGroup(groupName, true, targetFolder).then(res => {
                            const destFolder = targetFolder || currentFolder;
                            ctx.playbackStatus = res.ok
                                ? `Synced "${groupName}" — ${res.added} added to folder "${destFolder}", ${res.restored || 0} restored, ${res.missing || 0} missing.`
                                : (res.reason || 'Playlist sync failed.');
                            ctx.rerender();
                        });
                    }
                }
                else if (fName === 'playlist-link-form') {
                    const groupName = form.dataset.afGroup;
                    const PL = window.EveAudioflixPlaylists;
                    // getAll, not get: the Instagram panel gives each reel its own URL field, and
                    // get() would silently save the first row and drop every other line.
                    const lines = data.getAll('link').map((v) => String(v || '').trim()).filter(Boolean);
                    const res = PL?.setPlaylistLink?.(groupName, lines.join(String.fromCharCode(10)));
                    if (res?.ok) ctx.playlistLinkFormOpen = { open: false, group: '' };
                    ctx.playbackStatus = res?.ok
                        ? `Link for "${groupName}" saved — sync will use it from now on.`
                        : (res?.reason || 'Could not save that link.');
                    ctx.rerender();
                }
                else if (fName === 'localize-form') {
                    const scope = form.dataset.afScope || 'library';
                    const key = form.dataset.afKey || '';
                    const targetDir = data.get('targetDir');
                    const force = data.get('force') === '1' || data.get('force') === 'on';
                    const mode = ['dup', 'smart', 'link'].includes(String(data.get('mode') || '')) ? String(data.get('mode')) : 'link';
                    const mediaFormat = data.get('mediaFormat') === 'video' ? 'video' : 'audio';
                    const L = window.EveAudioflixLocalize;
                    if (L && targetDir) {
                        ctx.playbackStatus = 'Localizing candidate tracks...'; ctx.rerender();
                        L.localizeScope(scope, key, targetDir, (p) => {
                            ctx.playbackStatus = `Localizing ${p.index}/${p.total}: ${p.title}`;
                        }, force, mode, mediaFormat).then(res => {
                            ctx.playbackStatus = res.ok
                                ? (scope === 'group'
                                    ? `Group localized — ${res.done} downloaded, ${res.shortcut || 0} shortcut${res.shortcut === 1 ? '' : 's'}, ${res.skipped || 0} kept${res.failed ? `, ${res.failed} failed` : ''}.`
                                    : `Localized ${res.done}/${res.total} to ${res.targetDir}${res.failed ? ` (${res.failed} failed — ${res.lastError})` : ''}.`)
                                : (res.reason || 'Localization failed.');
                            ctx.localizeFormOpen = { open: false, scope: 'library', key: '' };
                            // Localization changes URLs/paths that the active card and backup layer
                            // both depend on. Flush immediately so the new offline path is visible
                            // and recoverable without requiring a page reload.
                            window.EveAudioflixState?.flush?.('audioflix-localize-complete');
                            ctx.rerender();
                        });
                    }
                }
                else if (fName === 'music-port-form') {
                    const path = String(data.get('path') || '').trim();
                    const folder = data.get('folder');
                    const L = window.EveAudioflixLocalize;
                    if (L) {
                        ctx.playbackStatus = path
                            ? 'Scanning local folder for music extraction...'
                            : 'Choose a music folder to import recursively...';
                        ctx.rerender();
                        L.importMusicPort(path, folder).then(async res => {
                            ctx.playbackStatus = res.ok
                                ? (res.reason || `Extracted ${res.added} track(s) into folder tag "${res.folder}".`)
                                : (res.reason || 'Music Port failed.');
                            if (res.ok) {
                                ctx.musicPortFormOpen = false;
                                await ctx.loadPortedSounds?.();
                                window.EveAudioflixState?.flush?.('audioflix-music-port-complete');
                            }
                            ctx.rerender();
                        });
                    }
                }
                else if (fName === 'add-classifier') {
                    const res = window.EveAudioflixClassifiers?.addManual?.(data.get('name'));
                    ctx.playbackStatus = res?.ok ? `Classifier "${res.name}" created — attach it from a track’s settings panel.` : (res?.reason || 'Could not add that classifier.');
                    ctx.rerender();
                }
                else if (fName === 'attach-classifier') {
                    const res = window.EveAudioflixClassifiers?.toggleOnTrack?.(id, data.get('name'), true);
                    if (res?.ok) ctx.playbackStatus = 'Classifier attached to this track.';
                    ctx.rerender();
                }
                else if (fName === 'edit-track') {
                    const title = data.get('title'), url = data.get('url'), artist = data.get('artist'), folder = data.get('folder'), localPath = data.get('localPath');
                    const patch = { title, url, artist, folder, card: folder };
                    if (localPath !== null && localPath !== undefined) patch.localPath = String(localPath).trim();
                    window.EveAudioflixState?.updateItem?.('music', id, patch);
                    if (ctx.activeInfoItem?.id === id) {
                        Object.assign(ctx.activeInfoItem, patch);
                    }
                    ctx.rerender();
                }
                else {
                    const itemType = fName === 'music' ? 'music' : 'sound';
                    window.EveAudioflixState?.addItem?.(itemType, { type: itemType, title: data.get('title'), url: data.get('url'), artist: data.get('artist'), folder: data.get('folder'), category: data.get('category'), volume: data.get('volume') });
                    ctx.pushHotkeysToBridge(); ctx.rerender();
                }
                form.reset();
            }
        return handleForm;
    };

    ns.ready = true;
})();
