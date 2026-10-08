window.EveAudioflixAudioSource = window.EveAudioflixAudioSource || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixAudioSource;
    if (ns.ready) return;

    const PLATFORM_RE = /^https?:\/\/(?:www\.|music\.)?(?:youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com|vimeo\.com|open\.spotify\.com|instagram\.com)\b/i;
    const PROVIDER_NATIVE_RE = /^https?:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]+(?:[/?#]|$)/i;

    function proxiedTarget(value) {
        const raw = String(value || '').trim();
        if (!raw.includes('/api/proxy?') || !raw.includes('url=')) return '';
        try {
            const parsed = new URL(raw, location.href);
            return String(parsed.searchParams.get('url') || '').trim();
        } catch {
            return '';
        }
    }

    function getOriginalPlatformUrl(item) {
        if (item?.sourceUrl && PLATFORM_RE.test(item.sourceUrl)) return item.sourceUrl;
        if (item?.originalUrl && PLATFORM_RE.test(item.originalUrl)) return item.originalUrl;
        const raw = String(item?.url || '').trim();
        if (PLATFORM_RE.test(raw)) return raw;
        const inner = proxiedTarget(raw);
        if (inner && PLATFORM_RE.test(inner)) return inner;
        return raw;
    }

    function needsResolution(url) {
        const value = String(url || '').trim();
        if (PROVIDER_NATIVE_RE.test(value)) return false;
        if (value.includes('/api/proxy?') || value.includes('googlevideo.com')) return true;
        // Ordinary HTTP media belongs to EveOS's localhost URL port. Only actual provider/page URLs
        // enter yt-dlp-style resolution; signed or extensionless media URLs must not be guessed into
        // a completely different recording/provider simply because their path lacks ".mp3".
        return PLATFORM_RE.test(value);
    }

    function keepRemoteMediaDirect(item) {
        const raw = String(item?.url || '').trim();
        if (!/^https?:\/\//i.test(raw) || PLATFORM_RE.test(raw) || raw.includes('googlevideo.com')) return item;
        // These fields are playback-copy metadata only. Clearing them prevents playDirect's legacy
        // "stream expired -> resolve original URL" retry from pulling an ordinary URL into yt-dlp.
        delete item.rawAudioUrl;
        item.originalUrl = '';
        item.eveOwnedRemoteUrl = true;
        return item;
    }

    async function resolveItem(item) {
        const safeItem = item && typeof item === 'object' ? { ...item } : {};
        const currentUrl = String(safeItem.url || '').trim();
        const inner = proxiedTarget(currentUrl);

        // Old builds persisted /api/proxy wrappers even for ordinary direct media. Peel those off so
        // the new /api/audioflix/port/url path can own the bytes and the normal <audio> volume again.
        if (inner && /^https?:\/\//i.test(inner) && !PLATFORM_RE.test(inner) && !inner.includes('googlevideo.com')) {
            safeItem.url = inner;
            return keepRemoteMediaDirect(safeItem);
        }

        const targetUrl = getOriginalPlatformUrl(safeItem);
        if (!targetUrl || !needsResolution(targetUrl)) return keepRemoteMediaDirect(safeItem);

        // Instagram uses its dedicated media resolver (and cache) instead of generic yt-dlp
        if (window.EveAudioflixUrlProviders?.providerFor?.(targetUrl) === 'instagram') {
            const resolver = window.EveAudioflixNative?.resolveInstagramVideo || window.EveAudioflixNative?.resolveUrl;
            const resolved = await resolver?.(targetUrl);
            const mediaUrl = resolved?.videoUrl || resolved?.audioUrl;
            if (!resolved?.ok || !mediaUrl) {
                const reason = resolved?.reason || 'The Instagram URL did not resolve to a playable video stream.';
                throw new Error(reason);
            }
            safeItem.sourceUrl = targetUrl;
            safeItem.url = window.EveAudioflixNative?.getProxyUrl?.(mediaUrl) || mediaUrl;
            safeItem.rawAudioUrl = mediaUrl;
            safeItem.resolvedDuration = Math.max(0, Number(resolved.duration || 0) || 0);
            safeItem.resolvedTitle = String(resolved.title || '').trim();
            return safeItem;
        }

        const isProxyOrExpired = String(safeItem.url || '').includes('/api/proxy?') || String(safeItem.url || '').includes('googlevideo.com');
        const resolved = await window.EveAudioflixNative?.resolveUrl?.(targetUrl, isProxyOrExpired);
        if (!resolved?.ok || !resolved.audioUrl) {
            const reason = resolved?.reason || 'The platform URL did not resolve to an audio stream.';
            throw new Error(reason);
        }

        safeItem.sourceUrl = targetUrl;
        safeItem.url = window.EveAudioflixNative?.getProxyUrl?.(resolved.audioUrl) || resolved.audioUrl;
        safeItem.rawAudioUrl = resolved.audioUrl;
        safeItem.resolvedDuration = Math.max(0, Number(resolved.duration || 0) || 0);
        safeItem.resolvedTitle = String(resolved.title || '').trim();
        return safeItem;
    }

    Object.assign(ns, {
        ready: true,
        getOriginalPlatformUrl,
        needsResolution,
        resolveItem
    });
})();
