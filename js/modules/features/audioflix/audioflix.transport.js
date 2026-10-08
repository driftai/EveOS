window.EveAudioflixTransport = window.EveAudioflixTransport || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixTransport;
    if (ns.ready) return;

    function formatTime(value) {
        const seconds = Math.max(0, Math.floor(Number(value || 0) || 0));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const tail = String(seconds % 60).padStart(2, '0');
        return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
    }

    function persistDuration(item, duration, type) {
        const seconds = Number(duration || 0);
        if (!item?.id || !Number.isFinite(seconds) || seconds <= 0) return 0;
        const itemType = type || item.type || 'music';
        const key = itemType === 'music' ? 'music' : 'soundboard';
        const stored = (window.EveAudioflixState?.ensure?.()[key] || []).find((entry) => entry.id === item.id);
        if (Number(stored?.duration || item.duration || 0) > 0) return Number(stored?.duration || item.duration);
        item.duration = seconds;
        window.EveAudioflixState?.updateItem?.(itemType, item.id, { duration: seconds });
        return seconds;
    }

    function readMetadataDuration(url, timeoutMs = 6000) {
        return new Promise((resolve) => {
            if (!url) return resolve(0);
            const audio = new Audio();
            audio.preload = 'metadata';
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                audio.removeAttribute('src');
                try { audio.load(); } catch {}
                resolve(Number.isFinite(value) && value > 0 ? value : 0);
            };
            const timer = setTimeout(() => finish(0), timeoutMs);
            audio.onloadedmetadata = () => finish(Number(audio.duration || 0));
            audio.onerror = () => finish(0);
            audio.src = url;
        });
    }

    async function probeItem(item, type, options = {}) {
        if (!item || Number(item.duration || 0) > 0) return Number(item?.duration || 0);
        const itemType = type || item.type || 'music';
        const rawUrl = String(item.url || '');
        const inlineBrowserUrl = /^(?:data:|blob:)/i.test(rawUrl);
        const local = item.localPath || (!/^https?:\/\//i.test(rawUrl) && !inlineBrowserUrl ? rawUrl : '');
        let probeUrl = inlineBrowserUrl ? rawUrl : '';
        if (local) {
            try { probeUrl = await window.EveAudioflixFsPorts?.fileUrlForPath?.(local) || ''; } catch {}
            if (!probeUrl) probeUrl = window.EveAudioflixNative?.getLocalFileUrl?.(local) || '';
        } else if (!probeUrl) {
            const needsResolution = window.EveAudioflixAudioSource?.needsResolution?.(item.url) === true;
            if (!needsResolution && /^https?:\/\//i.test(String(item.url || ''))) probeUrl = item.url;
            if (!probeUrl && options.resolveProvider && needsResolution) {
                try {
                    const resolved = await window.EveAudioflixNative?.resolveUrl?.(item.url);
                    const duration = Number(resolved?.duration || 0);
                    if (duration > 0) return persistDuration(item, duration, itemType);
                } catch {}
            }
        }
        const duration = await readMetadataDuration(probeUrl);
        return duration > 0 ? persistDuration(item, duration, itemType) : 0;
    }

    function spotifyProviderOwned(item, type) {
        if ((type || item?.type) !== 'music') return false;
        const directControl = window.EveAudioflixSpotifyVolume?.snapshot?.()?.directControl === true;
        if (directControl) return false;

        const playback = window.EveAudioflixAudio?.getPlaybackState?.() || {};
        const sameActiveItem = String(playback.item?.id ?? '') === String(item?.id ?? '');
        if (sameActiveItem && playback.provider === 'spotify' && playback.browserOnly === true) return true;

        const effectiveLocal = item?.missingLocal === true
            ? ''
            : (window.EveAudioflixLocalize?.effectiveLocalPath?.(item) || item?.localPath || '');
        if (String(effectiveLocal).trim()) return false;
        return window.EveAudioflixNativeSpotify?.isSpotifyTrack?.(item) === true
            || String(item?.sourceProvider || '').toLowerCase() === 'spotify'
            || /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)/i.test(String(item?.url || item?.spotifyUrl || item?.originalUrl || ''));
    }

    function render(item, type, escapeHtml) {
        const esc = escapeHtml || ((value) => String(value || ''));
        const volume = window.EveAudioflixState.normalizeVolume(item?.volume, 1);
        const id = esc(item?.id || '');
        const safeType = esc(type || 'sound');
        const knownDuration = Math.max(0, Number(item?.duration || 0) || 0);
        const providerOwnedVolume = spotifyProviderOwned(item, type);
        const volumeTitle = providerOwnedVolume
            ? `Spotify's official embed owns playback volume. EveOS saved ${Math.round(volume * 100)}% for a local/direct copy, but the current Spotify stream cannot be attenuated by this slider.`
            : 'Volume';
        const volumeAttrs = providerOwnedVolume
            ? ' disabled aria-disabled="true" data-af-volume-provider-owned="spotify"'
            : '';
        const volumeStyle = `--vol: ${volume * 100}%${providerOwnedVolume ? '; opacity: 0.42; cursor: not-allowed' : ''}`;
        const volumeLabel = providerOwnedVolume ? 'Spotify' : `${Math.round(volume * 100)}%`;
        const labelStyle = providerOwnedVolume ? ' style="opacity:1;visibility:visible;color:#1ed760"' : '';
        return `<div class="audioflix-item-transport" data-af-transport-id="${id}" data-af-duration="${knownDuration}"><span class="audioflix-time-current">0:00</span><input type="range" class="audioflix-seek-slider" min="0" max="${knownDuration || 1}" step="0.05" value="0" data-af-id="${id}" aria-label="Seek ${esc(item?.title || 'audio')}" disabled><span class="audioflix-time-duration">${knownDuration > 0 ? formatTime(knownDuration) : '--:--'}</span></div><div class="audioflix-item-volume-wrapper${providerOwnedVolume ? ' is-provider-owned' : ''}" title="${esc(volumeTitle)}"${providerOwnedVolume ? ' data-af-volume-provider-owned="spotify"' : ''}><input type="range" class="audioflix-volume-slider" min="0" max="1" step="0.01" value="${volume}" data-af-type="${safeType}" data-af-id="${id}" style="${volumeStyle}"${volumeAttrs}><span class="audioflix-volume-label"${labelStyle}>${esc(volumeLabel)}</span></div>`;
    }

    function preview(slider) {
        if (!slider) return;
        slider.dataset.afSeeking = 'true';
        const wrapper = slider.closest('.audioflix-item-transport');
        const duration = Number(slider.max || 0) || 0;
        const current = Math.max(0, Number(slider.value || 0) || 0);
        slider.style.setProperty('--seek', `${duration > 0 ? (current / duration) * 100 : 0}%`);
        const label = wrapper?.querySelector('.audioflix-time-current');
        if (label) label.textContent = formatTime(current);
    }

    function sync(root, playbackState) {
        const playback = playbackState?.item
            ? playbackState
            : (window.EveAudioflixAudio?.getPlaybackState?.() || {});
        const activeId = String(playback.item?.id || '');
        const duration = Math.max(0, Number(playback.duration || 0) || 0);
        if (duration > 0 && playback.item) persistDuration(playback.item, duration, playback.item.type);
        if (!root) return;
        const current = Math.max(0, Math.min(duration || Infinity, Number(playback.currentTime || 0) || 0));

        root.querySelectorAll('[data-af-transport-id]').forEach((transport) => {
            const isCurrent = !!activeId && transport.dataset.afTransportId === activeId;
            const card = transport.closest('.audioflix-item-card');
            card?.classList.toggle('is-current', isCurrent);
            const slider = transport.querySelector('.audioflix-seek-slider');
            if (!slider) return;
            slider.disabled = !isCurrent || duration <= 0;
            slider.max = String(duration || 1);
            if (slider.dataset.afSeeking !== 'true') {
                slider.value = String(isCurrent ? current : 0);
                slider.style.setProperty('--seek', `${isCurrent && duration > 0 ? (current / duration) * 100 : 0}%`);
                const currentLabel = transport.querySelector('.audioflix-time-current');
                if (currentLabel) currentLabel.textContent = formatTime(isCurrent ? current : 0);
            }
            const durationLabel = transport.querySelector('.audioflix-time-duration');
            const knownDuration = Math.max(0, Number(transport.dataset.afDuration || 0) || 0);
            if (durationLabel) durationLabel.textContent = isCurrent && duration > 0
                ? formatTime(duration) : (knownDuration > 0 ? formatTime(knownDuration) : '--:--');
        });
    }

    function finishSeek(slider) {
        if (slider) delete slider.dataset.afSeeking;
    }

    Object.assign(ns, { ready: true, render, preview, sync, finishSeek, formatTime, persistDuration, probeItem, spotifyProviderOwned });
})();
