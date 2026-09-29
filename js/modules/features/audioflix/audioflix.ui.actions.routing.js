// Output-routing UI actions share the panel's existing state accessor facade.
window.EveAudioflixUiActionsRouting = window.EveAudioflixUiActionsRouting || {};
(function (ns) {
    'use strict';
    ns.create = ctx => async (actionTarget, action) => {
            if (action === 'select-output') { try { await window.EveAudioflixAudio?.selectOutput?.(); } catch (err) { ctx.playbackStatus = err.message || 'Output selection failed'; } ctx.rerender(); return true; }
            if (action === 'unlock-output-names') {
                try { const ok = await window.EveAudioflixAudio?.unlockDeviceLabels?.(); ctx.playbackStatus = ok ? 'Output access granted.' : 'Output access still blocked here.'; }
                catch (err) { ctx.playbackStatus = err.message || 'Device name unlock failed'; } ctx.rerender(); return true;
            }
            if (action === 'local-only') {
                window.EveAudioflixGemini?.setVoicePortEnabled?.(false); window.EveAudioflixGemini?.setMonitorEnabled?.(true); window.EveAudioflixState?.update?.({ routeMode: 'browser' }, 'audioflix-local-playback');
                ctx.playbackStatus = 'Local only mode active'; ctx.rerender(); return true;
            }
            if (action === 'open-windows-mixer') { try { window.open('ms-settings:apps-volume', '_blank', 'noopener'); } catch(e){} ctx.playbackStatus = 'Open Windows Volume mixer...'; ctx.rerender(); return true; }
            if (action === 'mark-windows-route') { window.EveAudioflixState?.update?.({ routeMode: 'manual', geminiVoicePortEnabled: true }, 'audioflix-windows-mixer-route'); ctx.playbackStatus = 'Windows mixer route marked'; ctx.rerender(); return true; }
            if (action === 'refresh-native-devices') {
                try { const p = await window.EveAudioflixNative?.listSystemOutputs?.(true); ctx.playbackStatus = p?.message || 'Native outputs refreshed'; } catch (err) { ctx.playbackStatus = err.message || 'Native output refresh failed'; } ctx.rerender(); return true;
            }
            if (action === 'toggle-native-bridge') {
                const next = ctx.state().nativeBridgeEnabled !== true; window.EveAudioflixNative?.setNativeBridgeEnabled?.(next);
                const u = ctx.state(); ctx.playbackStatus = next && u.nativeBridgeEnabled ? `Native route enabled: ${u.nativeOutputLabel}` : 'Native route disabled';
                ctx.pushHotkeysToBridge(); ctx.rerender(); return true;
            }
            if (action === 'arm-cable') {
                try {
                    let dev = await window.EveAudioflixAudio?.listOutputs?.() || [], c = await window.EveAudioflixRouting?.findCableDevice?.() || dev.find(d => /(?:cable input|vb-audio virtual cable|vb-cable)/i.test(d.label || ''));
                    if (!c && window.EveAudioflixRouting?.hasAnonymousOutputs?.(dev) && await window.EveAudioflixAudio?.unlockDeviceLabels?.()) {
                        dev = await window.EveAudioflixAudio?.listOutputs?.() || [];
                        c = await window.EveAudioflixRouting?.findCableDevice?.() || dev.find(d => /(?:cable input|vb-audio virtual cable|vb-cable)/i.test(d.label || ''));
                    }
                    if (!c) { ctx.playbackStatus = 'CABLE Input not visible yet'; ctx.rerender(); return true; }
                    await window.EveAudioflixAudio?.setOutputById?.(c.deviceId, c.label || 'CABLE Input'); window.EveAudioflixGemini?.setVoicePortEnabled?.(true); ctx.playbackStatus = `Gemini voice port armed through ${c.label || 'CABLE Input'}`;
                } catch (err) { ctx.playbackStatus = err.message || 'CABLE Input preset failed'; } ctx.rerender(); return true;
            }
            if (action === 'test-signal') {
                try {
                    if (window.EveAudioflixGemini?.playVoiceRouteTest) ctx.playbackStatus = (await window.EveAudioflixGemini.playVoiceRouteTest())?.native ? 'Playing native bridge route test' : 'Playing Gemini WebAudio route test';
                    else { await window.EveAudioflixAudio?.playTestSignal?.(); ctx.playbackStatus = 'Playing Audioflix test signal'; }
                } catch (err) { ctx.playbackStatus = err.message || 'Test signal failed'; } ctx.rerender(); return true;
            }
            if (action === 'copy-route-status') { try { await window.EveAudioflixRouting?.copyRouteStatus?.(ctx.playbackStatus); ctx.playbackStatus = 'Routing status copied'; } catch (err) { ctx.playbackStatus = err.message || 'Copy status failed'; } ctx.rerender(); return true; }
            if (action === 'toggle-gemini-port') { const en = window.EveAudioflixGemini?.setVoicePortEnabled?.(!ctx.state().geminiVoicePortEnabled); ctx.playbackStatus = en ? 'Selective route armed' : 'Selective route disabled'; ctx.rerender(); return true; }
            if (action === 'toggle-gemini-monitor') { window.EveAudioflixGemini?.setMonitorEnabled?.(ctx.state().geminiVoiceMonitorEnabled === false); ctx.rerender(); return true; }
            if (action === 'toggle-gemini-mode') {
                const next = ctx.state().geminiConversationMode === 'text-brain-live-voice' ? 'direct-live' : 'text-brain-live-voice'; window.EveAudioflixGemini?.setConversationMode?.(next);
                ctx.playbackStatus = next === 'text-brain-live-voice' ? 'Mode 2 enabled.' : 'Direct Live mode enabled.'; ctx.rerender(); return true;
            }
            if (action === 'clear-gemini-events') { window.EveAudioflixState?.clearGeminiAudioEvents?.(); ctx.playbackStatus = 'Gemini event counter cleared'; ctx.rerender(); return true; }
        return false;
    };
    ns.ready = true;
})(window.EveAudioflixUiActionsRouting);
