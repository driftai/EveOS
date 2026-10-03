// Optional Spotify localization recovery for Audioflix.
//
// The existing localizer stays the default. This module decorates it at runtime so failed Spotify
// tracks can be retried only after an explicit user action, using the dedicated localhost fallback
// endpoint. It also adds the small recovery UI without growing the core localization modules past
// EveOS's first-party line cap.
window.EveAudioflixSpotifyFallback = window.EveAudioflixSpotifyFallback || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixSpotifyFallback;
    if (ns.ready) return;

    const L = window.EveAudioflixLocalize;
    const N = window.EveAudioflixNative;
    const Forms = window.EveAudioflixUiForms;
    const Actions = window.EveAudioflixUiActionsLocalize;
    const Ui = window.EveAudioflixUiLocalize;
    if (!L || !N || !Forms?.create || !Actions?.create || !Ui?.create) return;

    const text = (value) => String(value ?? '').trim();
    const same = (left, right) => text(left).toLowerCase() === text(right).toLowerCase();
    const state = () => window.EveAudioflixState?.ensure?.() || {};
    const music = () => state().music || [];
    const originalLocalizeScope = L.localizeScope.bind(L);
    const originalNativeLocalizeTrack = N.localizeTrack;
    let recovery = null;
    let activeRun = false;

    function isSpotifyTrack(track) {
        return text(track?.sourceProvider).toLowerCase() === 'spotify'
            || /^https?:\/\/open\.spotify\.com\/(?:embed\/)?track\//i.test(text(track?.url));
    }

    function fullTrack(track) {
        return music().find((item) => item.id === track?.id) || track || {};
    }

    function sourceFor(scope, key, track) {
        if (scope === 'folder') return `folder:${key}`;
        if (scope === 'group') return `group:${key}`;
        const folder = text(track?.folder || track?.card);
        return folder ? `folder:${folder}` : `manual:${track?.id || ''}`;
    }

    function failureFor(track, error, scope, key) {
        const item = fullTrack(track);
        return {
            id: item.id,
            title: text(item.title) || 'Untitled Track',
            url: text(item.url),
            source: sourceFor(scope, key, item),
            sourceProvider: text(item.sourceProvider),
            error: text(error) || 'download failed',
            fallbackEligible: isSpotifyTrack(item)
        };
    }

    function provenance(result, track) {
        return {
            method: 'spotify-fallback',
            resolver: text(result?.resolver),
            originalUrl: text(track?.url),
            matchedUrl: text(result?.matchedUrl)
        };
    }

    function addRecoveredLocalization(track, source, result) {
        const path = text(result?.filePath);
        if (!track?.id || !source || !path) return;
        const current = Array.isArray(track.localizations) ? track.localizations : [];
        const next = current.filter((entry) => !same(entry.source, source));
        next.push({ source, path, kind: 'file', ...provenance(result, track) });
        const localPath = L.effectiveLocalPath?.({ localizations: next, localPath: track.localPath }) || path;
        window.EveAudioflixState?.updateItem?.('music', track.id, { localizations: next, localPath, missingLocal: false });
    }

    function annotateFallbackSuccess(track, result) {
        const item = fullTrack(track);
        const path = text(result?.filePath);
        if (!item?.id || !path) return;
        const current = Array.isArray(item.localizations) ? item.localizations : [];
        let changed = false;
        const next = current.map((entry) => {
            if (!same(entry.path, path)) return entry;
            changed = true;
            return { ...entry, ...provenance(result, item) };
        });
        if (changed) window.EveAudioflixState?.updateItem?.('music', item.id, { localizations: next });
    }

    async function routeNativeTrack(track, targetDir, options, resolverMode, scope, key, failures, successes) {
        const item = fullTrack(track);
        const method = resolverMode === 'spotify-fallback' && isSpotifyTrack(item)
            ? 'spotify-fallback' : 'standard';
        let result;
        try {
            result = await originalNativeLocalizeTrack.call(N, track, targetDir, { ...options, method });
        } catch (error) {
            result = { ok: false, error: error?.message || String(error) };
        }
        if (!result?.ok) failures.push(failureFor(item, result?.error || result?.message, scope, key));
        else if (method === 'spotify-fallback' && result.filePath) successes.push({ track: item, result });
        return result;
    }

    async function localizeScopeCompat(scope, key, targetDir, onProgress, force = false, mode = 'link', mediaFormat = 'audio', resolverMode = 'standard') {
        if (activeRun) return { ok: false, reason: 'Another localization run is already in progress.' };
        activeRun = true;
        recovery = null;
        const resolver = resolverMode === 'spotify-fallback' ? 'spotify-fallback' : 'standard';
        const failures = [];
        const successes = [];
        const routed = (track, dir, options = {}) => routeNativeTrack(track, dir, options, resolver, scope, key, failures, successes);
        N.localizeTrack = routed;
        try {
            const result = await originalLocalizeScope(scope, key, targetDir, onProgress, force, mode, mediaFormat);
            successes.forEach(({ track, result: success }) => annotateFallbackSuccess(track, success));
            const eligible = resolver === 'standard' ? failures.filter((entry) => entry.fallbackEligible) : [];
            if (eligible.length) {
                recovery = { scope, key, targetDir: text(targetDir), mode, mediaFormat, failures: eligible, attempted: false, createdAt: Date.now() };
            }
            return {
                ...result,
                failures,
                fallbackEligible: eligible.length,
                resolverMode: resolver,
                recovery: eligible.length ? { eligible: true, count: eligible.length } : null
            };
        } catch (error) {
            return { ok: false, reason: error?.message || String(error), failures, resolverMode: resolver };
        } finally {
            if (N.localizeTrack === routed) N.localizeTrack = originalNativeLocalizeTrack;
            activeRun = false;
        }
    }

    function getSpotifyRecovery() {
        return recovery ? { ...recovery, failures: recovery.failures.map((entry) => ({ ...entry })) } : null;
    }

    function clearSpotifyRecovery() {
        recovery = null;
        return true;
    }

    async function retrySpotifyRecovery(onProgress) {
        const pending = getSpotifyRecovery();
        if (!pending?.failures?.length) return { ok: false, reason: 'No Spotify fallback recovery is pending.' };
        if (activeRun) return { ok: false, reason: 'Another localization run is already in progress.' };
        activeRun = true;
        const failures = [];
        let done = 0;
        let lastError = '';
        try {
            for (let index = 0; index < pending.failures.length; index += 1) {
                const failure = pending.failures[index];
                const track = music().find((item) => item.id === failure.id);
                onProgress?.({ index: index + 1, total: pending.failures.length, title: failure.title, resolverMode: 'spotify-fallback' });
                if (!track) {
                    failures.push({ ...failure, error: 'Track no longer exists in the Audioflix library.' });
                    lastError = failures.at(-1).error;
                    continue;
                }
                let result;
                try {
                    result = await originalNativeLocalizeTrack.call(N, track, pending.targetDir, { mediaFormat: pending.mediaFormat, method: 'spotify-fallback' });
                } catch (error) {
                    result = { ok: false, error: error?.message || String(error) };
                }
                if (result?.ok && result.filePath) {
                    addRecoveredLocalization(track, failure.source || sourceFor(pending.scope, pending.key, track), result);
                    done += 1;
                } else {
                    const next = failureFor(track, result?.error || result?.message, pending.scope, pending.key);
                    failures.push(next);
                    lastError = next.error;
                }
            }
        } finally {
            activeRun = false;
        }
        recovery = failures.length ? { ...pending, failures, attempted: true } : null;
        return { ok: done > 0 || failures.length === 0, done, failed: failures.length, total: pending.failures.length, targetDir: pending.targetDir, failures, lastError, resolverMode: 'spotify-fallback' };
    }

    L.localizeScope = localizeScopeCompat;
    L.isSpotifyTrack = isSpotifyTrack;
    L.getSpotifyRecovery = getSpotifyRecovery;
    L.clearSpotifyRecovery = clearSpotifyRecovery;
    L.retrySpotifyRecovery = retrySpotifyRecovery;

    const originalFormsCreate = Forms.create;
    Forms.create = function createFallbackAwareForms(ctx) {
        const originalHandle = originalFormsCreate(ctx);
        return function handleFallbackAwareForm(form) {
            if (form?.dataset?.afForm !== 'localize-form') return originalHandle(form);
            const data = new FormData(form);
            const scope = form.dataset.afScope || 'library';
            const key = form.dataset.afKey || '';
            const targetDir = data.get('targetDir');
            const force = data.get('force') === '1' || data.get('force') === 'on';
            const mode = ['dup', 'smart', 'link'].includes(String(data.get('mode') || '')) ? String(data.get('mode')) : 'link';
            const mediaFormat = data.get('mediaFormat') === 'video' ? 'video' : 'audio';
            if (!targetDir) return;
            ctx.playbackStatus = 'Localizing candidate tracks...';
            ctx.rerender();
            L.localizeScope(scope, key, targetDir, (progress) => {
                ctx.playbackStatus = `Localizing ${progress.index}/${progress.total}: ${progress.title}`;
            }, force, mode, mediaFormat, 'standard').then((result) => {
                const fallbackNote = result.fallbackEligible
                    ? ` ${result.fallbackEligible} Spotify track${result.fallbackEligible === 1 ? '' : 's'} can be retried with Spotify Fallback.` : '';
                ctx.playbackStatus = result.ok
                    ? (scope === 'group'
                        ? `Group localized - ${result.done} downloaded, ${result.shortcut || 0} shortcut${result.shortcut === 1 ? '' : 's'}, ${result.skipped || 0} kept${result.failed ? `, ${result.failed} failed` : ''}.${fallbackNote}`
                        : `Localized ${result.done}/${result.total} to ${result.targetDir}${result.failed ? ` (${result.failed} failed - ${result.lastError})` : ''}.${fallbackNote}`)
                    : ((result.reason || 'Localization failed.') + fallbackNote);
                ctx.localizeFormOpen = getSpotifyRecovery()?.failures?.length
                    ? { open: true, scope, key } : { open: false, scope: 'library', key: '' };
                window.EveAudioflixState?.flush?.('audioflix-localize-complete');
                ctx.rerender();
            });
        };
    };

    const originalActionsCreate = Actions.create;
    Actions.create = function createFallbackAwareActions(ctx) {
        const originalHandle = originalActionsCreate(ctx);
        return async function handleFallbackAction(actionTarget, action) {
            if (action === 'dismiss-spotify-recovery') {
                clearSpotifyRecovery();
                ctx.playbackStatus = 'Spotify fallback recovery dismissed; no fallback retry was run.';
                ctx.rerender();
                return true;
            }
            if (action === 'retry-spotify-fallback') {
                const pending = getSpotifyRecovery();
                if (!pending?.failures?.length) {
                    ctx.playbackStatus = 'No Spotify fallback recovery is pending.';
                    ctx.rerender();
                    return true;
                }
                ctx.playbackStatus = `Trying Spotify Fallback for ${pending.failures.length} failed track${pending.failures.length === 1 ? '' : 's'}...`;
                ctx.rerender();
                const result = await retrySpotifyRecovery((progress) => {
                    ctx.playbackStatus = `Spotify Fallback ${progress.index}/${progress.total}: ${progress.title}`;
                });
                ctx.playbackStatus = result.ok
                    ? `Spotify Fallback localized ${result.done}/${result.total}${result.failed ? `; ${result.failed} still failed - ${result.lastError}` : '.'}`
                    : (result.reason || `Spotify Fallback failed${result.lastError ? ` - ${result.lastError}` : '.'}`);
                if (!getSpotifyRecovery()?.failures?.length) ctx.localizeFormOpen = { open: false, scope: 'library', key: '' };
                window.EveAudioflixState?.flush?.('audioflix-spotify-fallback-complete');
                ctx.rerender();
                return true;
            }
            if (action === 'localize-spotify-fallback-scope') {
                const form = actionTarget.closest('form');
                if (!form) return true;
                const data = new FormData(form);
                const scope = form.dataset.afScope || 'library';
                const key = form.dataset.afKey || '';
                const targetDir = text(data.get('targetDir'));
                const force = data.get('force') === '1' || data.get('force') === 'on';
                const mode = ['dup', 'smart', 'link'].includes(String(data.get('mode') || '')) ? String(data.get('mode')) : 'link';
                const mediaFormat = data.get('mediaFormat') === 'video' ? 'video' : 'audio';
                const spotifyCount = (L.collectScope?.(scope, key) || []).filter(isSpotifyTrack).length;
                if (!targetDir || !spotifyCount) {
                    ctx.playbackStatus = !targetDir ? 'Choose a target folder before using Spotify Fallback.' : 'This scope has no Spotify-linked tracks for the fallback resolver.';
                    ctx.rerender();
                    return true;
                }
                ctx.playbackStatus = `Using Spotify Fallback for Spotify-linked tracks in this scope (${spotifyCount} available)...`;
                ctx.rerender();
                const result = await L.localizeScope(scope, key, targetDir, (progress) => {
                    ctx.playbackStatus = `Spotify Fallback ${progress.index}/${progress.total}: ${progress.title}`;
                }, force, mode, mediaFormat, 'spotify-fallback');
                ctx.playbackStatus = result.ok
                    ? (scope === 'group'
                        ? `Fallback run complete - ${result.done} downloaded, ${result.shortcut || 0} shortcut${result.shortcut === 1 ? '' : 's'}, ${result.skipped || 0} kept${result.failed ? `, ${result.failed} failed - ${result.lastError}` : ''}.`
                        : `Fallback run localized ${result.done}/${result.total} to ${result.targetDir}${result.failed ? ` (${result.failed} failed - ${result.lastError})` : ''}.`)
                    : (result.reason || 'Spotify fallback localization failed.');
                window.EveAudioflixState?.flush?.('audioflix-spotify-fallback-scope-complete');
                ctx.rerender();
                return true;
            }
            return originalHandle(actionTarget, action);
        };
    };

    const originalUiCreate = Ui.create;
    Ui.create = function createFallbackAwareUi(deps) {
        const base = originalUiCreate(deps);
        const esc = deps.esc;
        const originalRenderForm = base.renderLocalizeForm;
        const originalRenderSong = base.renderSongLocalizations;
        base.renderLocalizeForm = function renderFallbackAwareForm() {
            const html = originalRenderForm();
            const opened = deps.getLocalizeFormOpen?.() || {};
            const scope = opened.scope || 'library';
            const key = opened.key || '';
            const items = L.collectScope?.(scope, key) || [];
            const spotify = items.filter(isSpotifyTrack);
            const pending = getSpotifyRecovery();
            const pendingHere = pending && pending.scope === scope && pending.key === key && pending.failures?.length;
            const rows = pendingHere ? pending.failures.map((failure) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.06);"><strong style="color:#f8fafc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(failure.title)}</strong><span style="color:#fbbf24;font-size:.7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%;" title="${esc(failure.error)}">${esc(failure.error)}</span></div>`).join('') : '';
            const recoveryBlock = pendingHere ? `<div class="audioflix-spotify-recovery" style="padding:9px 10px;border:1px solid rgba(245,158,11,.45);background:rgba(245,158,11,.11);border-radius:10px;"><div style="font-weight:700;color:#fbbf24;">Spotify recovery available - ${pending.failures.length} track${pending.failures.length === 1 ? '' : 's'} ${pending.attempted ? 'still unresolved after fallback' : 'failed with the standard method'}</div><div style="font-size:.75rem;color:#cbd5e1;margin:3px 0 6px;">Nothing retries automatically. Choose whether to use the alternate Spotify resolver.</div><div style="max-height:130px;overflow-y:auto;margin-bottom:7px;">${rows}</div><div style="display:flex;gap:7px;flex-wrap:wrap;"><button type="button" class="audioflix-add-toggle" data-af-action="retry-spotify-fallback">${pending.attempted ? 'Retry' : 'Try'} Spotify Fallback (${pending.failures.length})</button><button type="button" class="audioflix-add-toggle" data-af-action="dismiss-spotify-recovery">Dismiss</button></div></div>` : '';
            const optionsBlock = spotify.length ? `<details style="padding:7px 9px;border:1px solid rgba(29,185,84,.28);background:rgba(29,185,84,.07);border-radius:9px;"><summary style="cursor:pointer;color:#86efac;font-size:.78rem;font-weight:650;">Spotify recovery options - ${spotify.length} Spotify-linked track${spotify.length === 1 ? '' : 's'}</summary><div style="font-size:.74rem;color:#cbd5e1;margin-top:6px;line-height:1.4;">Standard localization remains the default. The alternate resolver searches more independent-source candidates and runs only when you press the button below. Non-Spotify tracks in a mixed scope keep the standard resolver.</div><button type="button" class="audioflix-add-toggle" data-af-action="localize-spotify-fallback-scope" style="margin-top:7px;">Use Spotify Fallback for this scope</button></details>` : '';
            return html.replace('</form>', `${recoveryBlock}${optionsBlock}</form>`);
        };
        base.renderSongLocalizations = function renderFallbackSongLocalizations(track) {
            const html = originalRenderSong(track);
            const fallback = (track?.localizations || []).filter((entry) => entry.method === 'spotify-fallback');
            if (!fallback.length) return html;
            const names = [...new Set(fallback.map((entry) => text(entry.resolver) || 'alternate resolver'))].join(', ');
            return `${html}<div style="font-size:.7rem;color:#86efac;margin-top:4px;">Spotify Fallback localization retained (${esc(names)}); the original Spotify URL remains attached to the track.</div>`;
        };
        return base;
    };

    ns.ready = true;
})();
