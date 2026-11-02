// Spotify Engine management inside Nexus Audio Link. Presentation and actions delegate to the
// existing Spotify management facade; this module owns no playback, capture, or credential state.
window.EveAudioflixNexusSpotify = window.EveAudioflixNexusSpotify || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    let restartArmedUntil = 0;
    const management = () => window.EveAudioflixSpotifyManagement;
    const time = seconds => {
        const value = Math.max(0, Number(seconds || 0));
        return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
    };
    function render() {
        const value = management()?.snapshot?.() || {};
        const relay = value.relay || {}, managed = value.managed || {}, engine = value.engine || {};
        const capture = value.capture || {}, policy = value.policy || {}, item = value.item;
        const connected = relay.connected === true, waiting = relay.approvalRequired === true;
        const signed = String(managed.authState || 'unknown');
        const playing = engine.paused === false || value.playback?.playback?.paused === false;
        const presentation = String(managed.presentation || 'hidden');
        const output = policy.outputLabel || (policy.outputKind === 'native' ? policy.outputId || 'native route' : 'browser output');
        const captureText = capture.active === true
            ? `${capture.state || 'capturing'} · ${capture.nonzeroPcm ? 'PCM flowing' : 'waiting for PCM'} · ${capture.endpoint || output}`
            : capture.state === 'error' ? `error · ${capture.message || 'capture failed'}` : 'inactive';
        const playbackText = item
            ? `${item.title || 'Spotify'} · ${engine.status || (playing ? 'playing' : 'paused')} · ${time(engine.currentTime)} / ${time(engine.duration)}`
            : `${engine.status || 'idle'} · no selected Spotify item`;
        const error = relay.lastError || managed.lastError || '';
        const approval = waiting ? '<button type="button" data-af-action="nexus-spotify-approve">Approve EveOS</button>' : '';
        const connectLabel = relay.status === 'unavailable' ? 'Retry connection' : connected ? 'Refresh diagnostics' : 'Connect engine';
        const restartLabel = restartArmedUntil > Date.now() ? 'Confirm restart' : 'Restart engine';
        const volume = Math.max(0, Math.min(1, Number(item?.volume ?? 1)));
        const volumeControl = item ? `<label class="audioflix-nexus-spotify-volume"><span>Volume</span><input class="audioflix-volume-slider" type="range" min="0" max="1" step="0.01" value="${volume}" data-af-id="${esc(item.id)}" data-af-type="music" style="--vol:${Math.round(volume * 100)}%"><span>${Math.round(volume * 100)}%</span></label>` : '';
        return `<details class="audioflix-nexus-spotify" open><summary>Spotify Engine <span>${esc(connected ? signed : relay.status || 'idle')}</span></summary>
            <div class="audioflix-nexus-spotify-facts"><span>Relay <strong>${esc(relay.status || 'idle')}</strong></span><span>Account <strong>${esc(signed)}</strong></span><span>Owner <strong>${relay.lastState?.isOwner === true ? 'this EveOS tab' : connected ? 'observer / available' : 'none'}</strong></span><span>Engine <strong>${esc(managed.helperReachable ? presentation : managed.state || 'stopped')}</strong></span></div>
            <p><strong>Playback:</strong> ${esc(playbackText)}</p><p><strong>Capture:</strong> ${esc(captureText)}</p><p><strong>Requested output:</strong> ${esc(output)} · physical signal still requires the selected device meter.</p>
            ${error ? `<p class="audioflix-nexus-spotify-error">${esc(error)}</p>` : ''}${volumeControl}
            <div class="audioflix-nexus-spotify-actions"><button type="button" data-af-action="nexus-spotify-refresh">${esc(connectLabel)}</button>${approval}<button type="button" data-af-action="nexus-spotify-auth">Sign in / reauthenticate</button><button type="button" data-af-action="nexus-spotify-presentation" data-af-mode="${presentation === 'window' ? 'hidden' : 'window'}">${presentation === 'window' ? 'Hide' : 'Show'} engine</button><button type="button" data-af-action="nexus-spotify-toggle" ${item ? '' : 'disabled'}>${playing ? 'Pause' : 'Play / Resume'}</button><button type="button" data-af-action="nexus-spotify-stop-playback" ${item ? '' : 'disabled'}>Stop playback</button><button type="button" data-af-action="nexus-spotify-capture">${capture.active === true ? 'Stop capture' : 'Capture to native output'}</button><button type="button" data-af-action="provider-arm">Capture embed tab</button><button type="button" data-af-action="nexus-spotify-restart">${restartLabel}</button><button type="button" data-af-action="nexus-spotify-stop-engine">Stop engine</button></div>
            <div class="audioflix-nexus-spotify-modes"><span><strong>Managed mode:</strong> saved Spotify session, transport controls, authenticated PCM capture.</span><span><strong>Official embed:</strong> browser-owned player; native output requires explicit Provider Capture authorization.</span></div>
        </details>`;
    }
    async function handleAction(target, action, ctx) {
        if (!String(action || '').startsWith('nexus-spotify-')) return false;
        const api = management();
        try {
            let result;
            if (action === 'nexus-spotify-refresh') result = await api.refresh();
            if (action === 'nexus-spotify-approve') result = api.approve();
            if (action === 'nexus-spotify-auth') result = await api.authenticate();
            if (action === 'nexus-spotify-presentation') result = await api.setPresentation(target.dataset.afMode || 'window');
            if (action === 'nexus-spotify-toggle') result = await api.togglePlayback();
            if (action === 'nexus-spotify-stop-playback') result = await api.stopPlayback();
            if (action === 'nexus-spotify-capture') result = await api.toggleCapture();
            if (action === 'nexus-spotify-stop-engine') result = await api.stopEngine();
            if (action === 'nexus-spotify-restart') {
                if (restartArmedUntil <= Date.now()) {
                    restartArmedUntil = Date.now() + 8000;
                    ctx.playbackStatus = 'Press Confirm restart within 8 seconds. Playback will stop and will not auto-resume.';
                    ctx.rerender(); return true;
                }
                restartArmedUntil = 0; result = await api.restart();
            }
            ctx.playbackStatus = result?.approvalRequired
                ? 'Approve this EveOS tab before controlling Spotify.'
                : result?.message || result?.reason || 'Spotify Engine updated.';
        } catch (error) {
            ctx.playbackStatus = error?.message || 'Spotify Engine action failed.';
        }
        ctx.rerender();
        return true;
    }
    Object.assign(ns, { ready: true, render, handleAction });
})(window.EveAudioflixNexusSpotify);
