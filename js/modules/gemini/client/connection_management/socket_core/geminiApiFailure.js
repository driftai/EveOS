(function () {
    'use strict';

    if (window.EveGeminiApiFailure?.ready) return;

    function redact(value) {
        return String(value || '')
            .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1[redacted]')
            .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-api-key]');
    }

    function extractText(value) {
        if (value == null) return '';
        if (typeof value === 'string') return redact(value).trim();
        const parts = [];
        const add = (part) => {
            const text = redact(part).trim();
            if (text && !parts.includes(text)) parts.push(text);
        };
        add(value.message);
        add(value.reason);
        if (typeof value.error === 'string') add(value.error);
        add(value.error?.message);
        add(value.error?.reason);
        add(value.cause?.message);
        add(value.cause?.reason);
        add(value.detail);
        if (typeof value.data === 'string') add(value.data);
        if (Number.isFinite(Number(value.code))) add(`WebSocket close code ${value.code}`);
        return parts.join(' | ');
    }

    function result(kind, options) {
        return Object.freeze({
            kind,
            credential: !!options.credential,
            policyBlocked: !!options.policyBlocked,
            retryable: options.retryable !== false,
            status: options.status || '',
            message: options.message || '',
            detail: options.detail || ''
        });
    }

    function originatingIp(detail) {
        const match = String(detail || '').match(/originating ip address(?: of the call)?\s*\(([^)]+)\)/i);
        if (!match) return '';
        const candidate = match[1].trim();
        return /^[0-9a-f:.]+$/i.test(candidate) ? candidate : '';
    }

    function classify(value) {
        const detail = extractText(value);

        if (/(no api key configured|api key is required|missing api key)/i.test(detail)) {
            return result('missing-key', {
                credential: true,
                retryable: false,
                status: 'API Key Required',
                message: 'Save a Gemini API key in Search Monitor Session Controls, then reconnect.',
                detail
            });
        }
        if (/(api key not valid|invalid api key|please pass a valid api key|api_key_invalid)/i.test(detail)) {
            return result('invalid-key', {
                credential: true,
                retryable: false,
                status: 'API Key Invalid',
                message: 'Gemini rejected the saved API key as invalid. Save a valid key in Session Controls.',
                detail
            });
        }
        if (/(ip address restriction|originating ip address|ip allowlist|api_key_ip_address_blocked)/i.test(detail)) {
            const callerIp = originatingIp(detail);
            return result('ip-restriction', {
                credential: true,
                policyBlocked: true,
                retryable: false,
                status: 'API Key IP Mismatch',
                message: callerIp
                    ? `Google saw Gemini Link leave from ${callerIp}, which is not on this key's IP allowlist. Add that public IP or save a compatible Google AI Studio auth key, then click the connection status to retry.`
                    : 'Google rejected this key because its IP allowlist does not include the backend public address. Restart Gemini Link to apply direct IPv4 routing, update the allowed IPs if needed, then click the connection status to retry.',
                detail
            });
        }
        if (/(http referrer|referer restriction|website restriction|application restriction|api_key_http_referrer_blocked)/i.test(detail)) {
            return result('origin-restriction', {
                credential: true,
                policyBlocked: true,
                retryable: false,
                status: 'API Key Origin Mismatch',
                message: 'Google rejected this key for the current EveOS origin. Update its application restrictions or save a compatible Google AI Studio auth key.',
                detail
            });
        }
        if (/(reported as leaked|leaked api key|api key.*blocked.*leak|key.*compromised)/i.test(detail)) {
            return result('blocked-key', {
                credential: true,
                policyBlocked: true,
                retryable: false,
                status: 'API Key Blocked',
                message: 'Google has blocked this exposed or compromised key. Replace it with a new Google AI Studio auth key.',
                detail
            });
        }
        if (/(unrestricted (standard )?(api )?keys?|standard (api )?keys?).*(reject|not supported|not allowed|blocked)|restrict.*gemini api/i.test(detail)) {
            return result('key-policy', {
                credential: true,
                policyBlocked: true,
                retryable: false,
                status: 'API Key Policy Update',
                message: 'Google no longer accepts this unrestricted standard key. Restrict it to the Gemini API in AI Studio or create a new auth key.',
                detail
            });
        }
        if (/(not found for api version|not supported for bidigeneratecontent|is not found for|preview model issue)/i.test(detail)) {
            return result('model-unavailable', {
                status: 'Model Unavailable',
                message: 'The selected Gemini model is unavailable for this API operation.',
                detail
            });
        }
        if (/(quota exceeded|resource exhausted|rate limit|too many requests|\b429\b)/i.test(detail)) {
            return result('quota', {
                status: 'Gemini Quota Reached',
                message: 'Gemini quota or rate limits were reached. Retry after the service window resets.',
                detail
            });
        }
        if (/(temporary service disruption|service unavailable|connection reset|network error|\b50[0234]\b)/i.test(detail)) {
            return result('transient', {
                status: 'Gemini Temporarily Unavailable',
                message: 'Gemini is temporarily unavailable. EveOS will retry without disabling the saved credential.',
                detail
            });
        }
        return result('unknown', { detail, message: detail || 'Unknown Gemini transport failure.' });
    }

    function connectWithNormalizedWebSocket(connect, options) {
        const NativeWebSocket = window.WebSocket;
        if (typeof NativeWebSocket !== 'function') return connect();
        const NormalizedWebSocket = new Proxy(NativeWebSocket, {
            construct(Target, args) {
                const next = [...args];
                next[0] = String(next[0] || '').replace(/^(wss?:\/\/[^/]+)\/+ws\//i, '$1/ws/');
                const socket = Reflect.construct(Target, next);
                try { options?.onSocket?.(socket); } catch {}
                return socket;
            }
        });
        window.WebSocket = NormalizedWebSocket;
        try {
            return connect();
        } finally {
            window.WebSocket = NativeWebSocket;
        }
    }

    window.EveGeminiApiFailure = Object.freeze({
        ready: true,
        extractText,
        classify,
        connectWithNormalizedWebSocket
    });
})();
