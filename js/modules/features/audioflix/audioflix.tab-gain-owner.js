window.EveAudioflixTabGainOwner = window.EveAudioflixTabGainOwner || {};
(function () {
    'use strict';

    // Publishes which AudioFlix item may drive the Nexus extension's captured-tab GainNode.
    // The extension content script runs in an isolated world and cannot read page globals or
    // CustomEvent detail objects, so the contract is two attributes on <html>:
    //   data-af-tab-gain-owner  - id of the playing official Spotify embed item, or '' (none)
    //   data-af-tab-gain-volume - that item's normalized 0..1 volume, or '1' when no owner
    // Only the official Spotify embed lacks its own volume API. Every other transport (local
    // files, YouTube, SoundCloud, direct media) already applies the slider itself, so the tab
    // gain must stay at unity for them or the slider would attenuate twice (0.5 -> 0.25).
    const ns = window.EveAudioflixTabGainOwner;
    if (ns.ready) return;

    const OWNER_ATTR = 'data-af-tab-gain-owner';
    const VOLUME_ATTR = 'data-af-tab-gain-volume';
    const SPOTIFY_TRACK = /open\.spotify\.com\/(?:embed\/)?track\//i;
    const clamp = (value, fallback = 1) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
    };

    function isOfficialSpotifyEmbed(item) {
        if (!item || typeof item !== 'object') return false;
        if (item.spotifyPlaybackMode === 'official-embed') return true;
        return SPOTIFY_TRACK.test(String(item.url || ''));
    }

    function publish(ownerId, volume) {
        const root = document.documentElement;
        if (!root) return;
        const owner = ownerId === undefined || ownerId === null ? '' : String(ownerId);
        const level = owner ? clamp(volume) : 1;
        if (root.getAttribute(OWNER_ATTR) !== owner) root.setAttribute(OWNER_ATTR, owner);
        const levelText = String(level);
        if (root.getAttribute(VOLUME_ATTR) !== levelText) root.setAttribute(VOLUME_ATTR, levelText);
    }

    function onPlayback(detail = {}) {
        const item = detail.item;
        const status = String(detail.status || '');
        // A non-Spotify transport, an error, or a finished/stopped item releases the gain to unity.
        // The next Spotify group track re-claims it on its own playback event.
        if (detail.error || /^(Ended|Stopped)/i.test(status) || !isOfficialSpotifyEmbed(item)) {
            publish('', 1);
            return;
        }
        publish(item.id, item.volume ?? 1);
    }

    function onSliderInput(event) {
        const target = event.target;
        if (!target?.matches?.('.audioflix-volume-slider')) return;
        const owner = document.documentElement?.getAttribute(OWNER_ATTR) || '';
        if (!owner || owner !== String(target.dataset.afId ?? '')) return;
        publish(owner, target.value);
    }

    window.addEventListener('eve:audioflix-playback', (event) => onPlayback(event.detail || {}));
    document.addEventListener('input', onSliderInput, true);
    publish('', 1);

    Object.assign(ns, { ready: true, OWNER_ATTR, VOLUME_ATTR, isOfficialSpotifyEmbed, onPlayback, publish });
})();
