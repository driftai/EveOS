window.EveAudioflixProviderCaptureUi = window.EveAudioflixProviderCaptureUi || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

    function renderCard() {
        const status = window.EveAudioflixProviderCapture?.getStatus?.() || {};
        const active = status.active === true;
        const facts = [
            `Permission: ${status.authorization || 'required'}`,
            `Audio: ${status.audioTrack ? 'track present' : 'not captured'}`,
            `PCM: ${status.nonzeroPcm ? 'nonzero' : 'waiting'}`,
            `Transport: ${status.transport ? 'accepted' : 'waiting'}`,
            `Renderer: ${status.renderer ? 'running' : 'idle'}`,
            `Suppression: ${status.suppression || 'not checked'}`
        ].join(' · ');
        return `<section class="audioflix-status-grid"><article data-af-provider-card class="audioflix-status-card ${active ? 'is-on' : ''}">
            <span>Provider Audio Capture</span><strong data-af-provider-state>${esc(status.state || 'idle')}</strong>
            <p data-af-provider-message>${esc(status.message || 'Capture is not armed.')}</p>
            <p data-af-provider-facts class="audioflix-mini-status">${esc(facts)}</p>
            <p data-af-provider-counts class="audioflix-mini-status">Endpoint: ${esc(status.endpoint || 'not reserved')} · Gain ${Math.round((status.gain ?? 1) * 100)}% · Chunks ${status.chunks || 0} · Dropped ${status.dropped || 0}</p>
            <p class="audioflix-mini-status">Physical output: not independently verified; check the actual device meter.</p>
            <button type="button" data-af-action="provider-test-tone" ${active ? 'disabled' : ''}>Test Provider PCM</button>
            <button type="button" data-af-action="provider-arm" ${active ? 'disabled' : ''}>Arm Provider Audio</button>
            <button type="button" data-af-action="provider-stop" ${active ? '' : 'disabled'}>Stop Capture</button>
        </article></section>`;
    }

    function syncLiveStatus() {
        const status = window.EveAudioflixProviderCapture?.getStatus?.() || {};
        const facts = [
            `Permission: ${status.authorization || 'required'}`,
            `Audio: ${status.audioTrack ? 'track present' : 'not captured'}`,
            `PCM: ${status.nonzeroPcm ? 'nonzero' : 'waiting'}`,
            `Transport: ${status.transport ? 'accepted' : 'waiting'}`,
            `Renderer: ${status.renderer ? 'running' : 'idle'}`,
            `Suppression: ${status.suppression || 'not checked'}`
        ].join(' · ');
        document.querySelectorAll('[data-af-provider-card]').forEach(card => {
            card.classList.toggle('is-on', status.active === true);
            const write = (selector, value) => { const target = card.querySelector(selector); if (target) target.textContent = value; };
            write('[data-af-provider-state]', status.state || 'idle');
            write('[data-af-provider-message]', status.message || 'Capture is not armed.');
            write('[data-af-provider-facts]', facts);
            write('[data-af-provider-counts]', `Endpoint: ${status.endpoint || 'not reserved'} · Gain ${Math.round((status.gain ?? 1) * 100)}% · Chunks ${status.chunks || 0} · Dropped ${status.dropped || 0}`);
            for (const action of ['provider-test-tone', 'provider-arm', 'provider-stop']) {
                const button = card.querySelector(`[data-af-action="${action}"]`);
                if (button) button.disabled = action === 'provider-stop' ? status.active !== true : status.active === true;
            }
        });
    }
    window.addEventListener('eve:audioflix-provider-capture', syncLiveStatus);

    async function handleAction(_target, action, ctx) {
        if (!['provider-test-tone', 'provider-arm', 'provider-stop'].includes(action)) return false;
        try {
            if (action === 'provider-test-tone') await window.EveAudioflixProviderCapture?.testTone?.();
            if (action === 'provider-arm') await window.EveAudioflixProviderCapture?.armProviderTab?.();
            if (action === 'provider-stop') await window.EveAudioflixProviderCapture?.stop?.('user');
            ctx.playbackStatus = window.EveAudioflixProviderCapture?.getStatus?.().message || 'Provider capture updated.';
        } catch (error) {
            ctx.playbackStatus = error?.message || 'Provider capture failed.';
        }
        ctx.rerender();
        return true;
    }

    const routing = window.EveAudioflixRouting;
    if (routing?.renderStatusCards && !routing.__providerCaptureWrapped) {
        const original = routing.renderStatusCards;
        routing.renderStatusCards = (...args) => original(...args) + renderCard();
        routing.__providerCaptureWrapped = true;
    }
    Object.assign(ns, { ready: true, renderCard, handleAction });
})(window.EveAudioflixProviderCaptureUi);
