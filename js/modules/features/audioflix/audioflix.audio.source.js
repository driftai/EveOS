window.EveAudioflixAudioSource = window.EveAudioflixAudioSource || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixAudioSource;
    if (ns.ready) return;

    const DIRECT_AUDIO_RE = /\.(mp3|mp4|wav|ogg|oga|flac|aac|m4a|webm|opus)(?:$|[?#])/i;
    const PLATFORM_RE = /^https?:\/\/(?:www\.|music\.)?(?:youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com|vimeo\.com|open\.spotify\.com|instagram\.com)\b/i;
    const PROVIDER_NATIVE_RE = /^https?:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]+(?:[/?#]|$)/i;

    function getOriginalPlatformUrl(item) {
        if (item?.sourceUrl && PLATFORM_RE.test(item.sourceUrl)) return item.sourceUrl;
        if (item?.originalUrl && PLATFORM_RE.test(item.originalUrl)) return item.originalUrl;
        const raw = String(item?.url || '').trim();
        if (PLATFORM_RE.test(raw)) return raw;
        if (raw.includes('/api/proxy?') && raw.includes('url=')) {
            try {
                const parsed = new URL(raw);
                const inner = parsed.searchParams.get('url');
                if (inner && PLATFORM_RE.test(inner)) return inner;
            } catch {}
        }
        return raw;
    }

    function needsResolution(url) {
        const value = String(url || '').trim();
        if (PROVIDER_NATIVE_RE.test(value)) return false;
        if (value.includes('/api/proxy?') || value.includes('googlevideo.com')) return true;
        return PLATFORM_RE.test(value) || (/^https?:\/\//i.test(value) && !DIRECT_AUDIO_RE.test(value));
    }

    async function resolveItem(item) {
        const safeItem = item && typeof item === 'object' ? { ...item } : {};
        const targetUrl = getOriginalPlatformUrl(safeItem);
        if (!targetUrl || !needsResolution(targetUrl)) return safeItem;

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