window.EveAudioflixRouting = window.EveAudioflixRouting || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixRouting;
    if (ns.ready) return;

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, function (char) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
        });
    }

    function state() {
        return window.EveAudioflixState?.ensure?.() || {};
    }

    function isCableLabel(label) {
        return /(?:cable input|vb-audio virtual cable|vb-cable|voicemeeter input)/i.test(String(label || ''));
    }

    function isAnonymousOutput(label) {
        const text = String(label || '').trim();
        return !text || /^Output device\s+\d+$/i.test(text);
    }

    function hasAnonymousOutputs(devices) {
        return (devices || []).some((device) => isAnonymousOutput(device.label));
    }

    function renderBrowserOptions(devices, entry) {
        if (!devices.length) {
            return '<option value="">No browser output list; use picker, Native Bridge, or Mixer</option>';
        }
        if (hasAnonymousOutputs(devices)) {
            return [
                '<option value="">Default output</option>',
                '<option value="" disabled>Output names hidden - grant output access first</option>'
            ].join('');
        }
        return ['<option value="">Default output</option>'].concat(devices.map((device) => {
            const blockedById = entry.blocked && device.deviceId === entry.blocked;
            // Monitor is meant for real speakers/headphones. Routing it to a CABLE Input would feed
            // Gemini's voice straight back into the mic path -> feedback loop. Block CABLE sinks here.
            const blockedCable = entry.blockCable && isCableLabel(device.label);
            const blocked = blockedById || blockedCable;
            const suffix = blockedCable ? ' (avoid - feedback loop)' : (blockedById ? ' (Voice Port route)' : '');
            const label = `${device.label || (blocked ? 'Selected output' : 'Output')}${suffix}`;
            return `<option value="${esc(device.deviceId)}"${blocked ? ' disabled' : ''}>${esc(label)}</option>`;
        })).join('');
    }

    function routeLabel(snapshot, audioStatus) {
        if (snapshot.nativeBridgeEnabled === true && snapshot.nativeOutputId) return snapshot.nativeOutputLabel || 'Native Audioflix bridge';
        if (snapshot.routeMode === 'manual') return 'Windows Mixer -> CABLE Input';
        return snapshot.preferredSinkLabel || (audioStatus.hasSetSinkId ? 'Default browser output' : 'Default output');
    }

    function browserCoreState(snapshot, audioStatus) {
        if (snapshot.routeMode === 'manual') {
            return {
                selected: false,
                canPick: audioStatus.hasSetSinkId && audioStatus.hasOutputPicker,
                labelsVisible: audioStatus.hasEnumerate && !!snapshot.preferredSinkLabel,
                title: 'Windows mixer route active',
                detail: 'EveOS will not guess a browser sink here. Windows Volume mixer is the source of truth for routing this Edge/EveOS window to CABLE Input.'
            };
        }
        const selected = ['browser', 'browser-selective', 'vb-cable'].includes(snapshot.routeMode) && !!snapshot.preferredSinkId;
        const canPick = audioStatus.hasSetSinkId && audioStatus.hasOutputPicker;
        const labelsVisible = audioStatus.hasEnumerate && !!snapshot.preferredSinkLabel;
        return {
            selected,
            canPick,
            labelsVisible,
            title: selected ? 'Selective site output ready' : (canPick ? 'System default output active' : 'System default output'),
            detail: selected
                ? `EveOS can route Audioflix and Gemini WebAudio to ${snapshot.preferredSinkLabel || 'the selected output'} without moving all Edge audio.`
                : (canPick
                    ? 'Audioflix plays through the normal browser/OS output. Choose another output only when you want one.'
                    : 'Audioflix uses the browser/OS default output; Windows Mixer remains an optional override.')
        };
    }

    function healthItems(snapshot, audioStatus) {
        const hasRouteApi = !!audioStatus.hasSetSinkId;
        const hasOutput = !!snapshot.preferredSinkLabel;
        const manualMixer = snapshot.routeMode === 'manual';
        const browserCore = browserCoreState(snapshot, audioStatus);
        const nativeRoute = snapshot.nativeBridgeEnabled === true && !!snapshot.nativeOutputId;
        const onCable = manualMixer || isCableLabel(snapshot.preferredSinkLabel) || (nativeRoute && isCableLabel(snapshot.nativeOutputLabel));
        const armed = snapshot.geminiVoicePortEnabled === true || manualMixer || nativeRoute;
        return [
            { label: 'Output routing', state: 'ready', text: manualMixer ? 'Windows mixer' : (browserCore.selected ? 'Selected device' : 'System default') },
            { label: 'Audio output', state: onCable || !armed ? 'ready' : (hasOutput ? 'warn' : 'manual'), text: onCable ? 'Virtual cable' : (!armed ? 'Local speakers' : 'Choose output') },
            { label: 'Voice port', state: 'ready', text: nativeRoute ? 'Gemini + Audioflix' : (armed ? 'Gemini only' : 'Optional / off') },
            { label: 'Voicemeeter mic', state: armed ? 'manual' : 'ready', text: armed ? 'Route B1/B2 if needed' : 'Not required' }
        ];
    }

    function nextStep(snapshot, audioStatus) {
        if (snapshot.routeMode === 'manual' && snapshot.geminiVoicePortEnabled === true) {
            return {
                state: 'ready',
                title: 'Windows mixer route is marked',
                body: 'EveOS will treat Edge/browser audio as already routed to CABLE Input. Use Test Route and Copy Route to verify or share the setup.'
            };
        }
        if (snapshot.nativeBridgeEnabled === true && snapshot.nativeOutputId) {
            return {
                state: 'ready',
                title: 'Native EveOS-only route active',
                body: `Gemini PCM, route tests, and local/served Audioflix clips are sent to ${snapshot.nativeOutputLabel || 'the selected native output'} through the local EveOS server. Edge default can stay unchanged.`
            };
        }
        if (audioStatus.hasOutputPicker && audioStatus.hasSetSinkId && !snapshot.preferredSinkId) {
            return {
                state: 'ready',
                title: 'System default playback ready',
                body: 'Audioflix plays normally through the browser/OS output. Pick another output only when you want speakers, headphones, or an optional virtual route.'
            };
        }
        if (!audioStatus.hasSetSinkId) {
            return {
                state: 'manual',
                title: 'Use Windows mixer routing',
                body: 'This browser cannot directly pick an output sink here. Use Windows volume mixer to route the EveOS browser to CABLE Input.'
            };
        }
        if (!isCableLabel(snapshot.preferredSinkLabel)) {
            return {
                state: 'warn',
                title: 'Choose your routing source',
                body: 'Use Auto CABLE + Arm for selective Gemini-only routing, or mark Windows Mixer Routed if you already route all Edge/EveOS audio in Windows.'
            };
        }
        if (snapshot.geminiVoicePortEnabled !== true) {
            return {
                state: 'manual',
                title: 'Arm selective Gemini route',
                body: 'CABLE Input is selected. Arm the port so Gemini WebAudio goes to VB-CABLE while normal Edge audio can stay on your default speakers.'
            };
        }
        return {
            state: 'ready',
            title: 'Selective Gemini route is ready',
            body: 'Use Test Route to verify the WebAudio path, then select Voicemeeter Out B1/B2 as the microphone in the target app.'
        };
    }

    function renderHealth(snapshot, audioStatus) {
        return `<div class="audioflix-route-health">
            ${healthItems(snapshot, audioStatus).map((item) => `<span class="audioflix-health-${item.state}">
                <b>${esc(item.label)}</b>${esc(item.text)}
            </span>`).join('')}
        </div>`;
    }

    function renderStatusCards(snapshot, playbackStatus) {
        const audioStatus = window.EveAudioflixAudio?.getStatus?.() || {};
        const geminiStatus = window.EveAudioflixGemini?.getStatus?.() || {};
        const geminiUsage = window.EveGeminiUsageTelemetry?.getTotals?.() || null;
        const label = routeLabel(snapshot, audioStatus);
        const monitorOn = snapshot.geminiVoiceMonitorEnabled !== false;
        const monitorLabel = snapshot.geminiVoiceMonitorSinkLabel || 'Default monitor output';
        const nativeLabel = snapshot.nativeOutputLabel || 'No native output selected';
        const nativeInputLabel = snapshot.nativeInputLabel || 'No mic target noted';
        const guidance = nextStep(snapshot, audioStatus);
        const browserCore = browserCoreState(snapshot, audioStatus);
        return `<section class="audioflix-route-board" aria-label="Gemini voice route">
            <div class="audioflix-route-node"><span>Gemini Voice</span><strong>${snapshot.nativeBridgeEnabled ? 'Native route active' : (snapshot.geminiVoicePortEnabled ? 'Selective route armed' : 'Default playback')}</strong></div>
            <div class="audioflix-route-arrow">-&gt;</div>
            <div class="audioflix-route-node ${snapshot.geminiVoicePortEnabled || snapshot.nativeBridgeEnabled ? 'is-hot' : ''}"><span>Output Sink</span><strong>${esc(label)}</strong></div>
            <div class="audioflix-route-arrow">-&gt;</div>
            <div class="audioflix-route-node"><span>${snapshot.geminiVoicePortEnabled || snapshot.nativeBridgeEnabled ? 'Optional virtual mic' : 'Local audio'}</span><strong>${snapshot.geminiVoicePortEnabled || snapshot.nativeBridgeEnabled ? 'Voicemeeter / selected port' : 'No virtual device required'}</strong></div>
            <div class="audioflix-route-monitor"><span>Listen locally</span><strong>${monitorOn ? esc(monitorLabel) : 'Muted'}</strong></div>
            <div class="audioflix-route-guide audioflix-health-${guidance.state}">
                <span>Next useful action</span>
                <strong>${esc(guidance.title)}</strong>
                <p>${esc(guidance.body)}</p>
            </div>
            ${renderHealth(snapshot, audioStatus)}
            <div class="audioflix-route-actions">
                ${window.location.protocol === 'file:' ? `<button type="button" data-af-action="open-localhost" style="border-color: rgba(0, 212, 255, 0.4); color: #00d4ff; background: rgba(0, 212, 255, 0.1);">Localhost Site</button>` : ''}
                <button type="button" data-af-action="local-only">System Default Playback</button>
                <button type="button" data-af-action="open-windows-mixer">Open Mixer</button>
                <button type="button" data-af-action="mark-windows-route">Windows Mixer Routed</button>
                <button type="button" data-af-action="arm-cable">Auto CABLE + Arm</button>
                <button type="button" data-af-action="test-signal">Test Route</button>
                <button type="button" data-af-action="copy-route-status">Copy Route</button>
            </div>
        </section>
        <section class="audioflix-status-grid">${window.EveAudioflixOutputPort?.render?.(snapshot) || ''}
            <article class="audioflix-status-card is-core">
                <span>Browser Output Core</span>
                <strong>${esc(browserCore.title)}</strong>
                <p>${esc(browserCore.detail)}</p>
                <p class="audioflix-mini-status">Secure: ${audioStatus.secureContext ? 'yes' : 'limited'} · Output API: ${audioStatus.hasSetSinkId ? 'yes' : 'no'} · Picker: ${audioStatus.hasOutputPicker ? 'yes' : 'no'}</p>
                <div class="audioflix-output-picker">
                    <select data-af-control="output-select" aria-label="Audio output device">
                        <option value="">Loading devices...</option>
                    </select>
                    <p class="audioflix-output-note" data-af-output-note>Checking browser output permissions...</p>
                </div>
                <button type="button" data-af-action="unlock-output-names">Grant Output Access</button>
                <button type="button" data-af-action="select-output">Pick Browser Output</button>
            </article>
            <article class="audioflix-status-card ${snapshot.nativeBridgeEnabled ? 'is-on' : ''}">
                <span>Native Bridge Output</span>
                <strong>${esc(snapshot.nativeBridgeEnabled ? nativeLabel : 'Optional EveOS-only route')}</strong>
                <p>Optional exclusive route through the EveOS server. Selecting an endpoint only configures it; Use Native Route explicitly moves Audioflix playback there.</p>
                <div class="audioflix-output-picker">
                    <select data-af-control="native-output-select" aria-label="Native Audioflix output device">
                        <option value="">Checking native bridge...</option>
                    </select>
                    <p class="audioflix-output-note" data-af-native-output-note>Server device bridge not checked yet.</p>
                </div>
                <div class="audioflix-output-picker">
                    <select data-af-control="native-input-select" aria-label="Virtual microphone target">
                        <option value="">Checking mic targets...</option>
                    </select>
                    <p class="audioflix-output-note" data-af-native-input-note>${esc(nativeInputLabel)}</p>
                </div>
                <button type="button" data-af-action="refresh-native-devices">Refresh System Outputs</button>
                <button type="button" data-af-action="toggle-native-bridge">${snapshot.nativeBridgeEnabled ? 'Disable Native Route' : 'Use Native Route'}</button>
            </article>
            <article class="audioflix-status-card ${snapshot.geminiVoicePortEnabled ? 'is-on' : ''}">
                <span>Gemini Voice Port</span>
                <strong>${snapshot.geminiVoicePortEnabled ? 'Selective route armed' : 'Default playback'}</strong>
                <p>${snapshot.nativeBridgeEnabled
                    ? 'Native Bridge sends Gemini PCM and Audioflix-owned local clips through the selected local output and can suppress duplicate browser playback.'
                    : (snapshot.geminiVoicePortEnabled
                        ? 'Armed means Gemini Live WebAudio will try to use the selected browser sink. Pick CABLE Input or mark Windows Mixer Routed.'
                        : 'Disarmed means Gemini Live uses normal browser/default playback.')}</p>
                <button type="button" data-af-action="toggle-gemini-port">${snapshot.geminiVoicePortEnabled ? 'Disable Selective Route' : 'Arm Selective Route'}</button>
            </article>
            <article class="audioflix-status-card ${monitorOn ? 'is-on' : ''}">
                <span>Local Monitor</span>
                <strong>${monitorOn ? esc(monitorLabel) : 'Monitor muted'}</strong>
                <p>Mirrors Gemini voice to real speakers/headphones while CABLE Input feeds the mic route.</p>
                <div class="audioflix-output-picker">
                    <select data-af-control="monitor-output-select" aria-label="Gemini monitor output device">
                        <option value="">Loading devices...</option>
                    </select>
                </div>
                <button type="button" data-af-action="toggle-gemini-monitor">${monitorOn ? 'Mute Monitor' : 'Hear Monitor'}</button>
            </article>
            <article class="audioflix-status-card">
                <span>Conversation Mode</span>
                <strong>${snapshot.geminiConversationMode === 'text-brain-live-voice' ? 'Text Brain -> Live Voice' : 'Direct Live'}</strong>
                <p class="audioflix-status-token-desc">${geminiUsage?.combined?.interactions
                    ? `Gemini session: ${geminiUsage.combined.total.toLocaleString()} tokens (Live ${geminiUsage.live.total.toLocaleString()} / text brain ${geminiUsage.textBrain.total.toLocaleString()}).`
                    : (window.EveGeminiMode2?.ready
                        ? 'Token telemetry is ready. Mode 2 sends context through the text brain, then Live speaks the reply.'
                        : 'Gemini token telemetry loads with Search Monitor.')}</p>
                <button type="button" data-af-action="toggle-gemini-mode">${snapshot.geminiConversationMode === 'text-brain-live-voice' ? 'Use Direct Live' : 'Use Mode 2'}</button>
            </article>
            <article class="audioflix-status-card">
                <span>Signal</span>
                <strong class="audioflix-status-signal-value">${esc(playbackStatus)}</strong>
                <p>${esc(geminiStatus.lastEvent ? `Gemini audio seen: ${new Date(geminiStatus.lastEvent.at).toLocaleTimeString()}` : 'Waiting for local or Gemini playback.')}</p>
            </article>
        </section>`;
    }

    function renderRouter(snapshot) {
        const armed = snapshot.geminiVoicePortEnabled === true;
        const onCable = isCableLabel(snapshot.preferredSinkLabel);
        return `<div class="audioflix-vbcable-preset ${armed && onCable ? 'is-done' : ''}">
            <div class="audioflix-vbcable-copy">
                <h3>Voicemeeter Banana Route</h3>
                <p>${armed && onCable
                    ? 'EveOS side is ready: Gemini voice is routed to CABLE Input and the port is armed.'
                    : 'Route Gemini voice to CABLE Input, then use Voicemeeter B1/B2 as the target-app microphone.'}</p>
            </div>
            <button type="button" data-af-action="arm-cable">${armed && onCable ? 'Re-apply Voice Port' : 'Apply Voice Port'}</button>
        </div>
        <div class="audioflix-router-notes">
            <article>
                <h3>1. Audioflix</h3>
                <ol>
                    <li>Set <strong>Output Router</strong> to <strong>CABLE Input</strong>.</li>
                    <li>Enable <strong>Gemini Voice Port</strong>.</li>
                    <li>Use <strong>Test Signal</strong> to confirm the route.</li>
                </ol>
            </article>
            <article>
                <h3>2. Voicemeeter</h3>
                <ol>
                    <li>Use <strong>CABLE Output</strong> as an input strip.</li>
                    <li>Send that strip to <strong>B1</strong> or <strong>B2</strong>.</li>
                    <li>Optionally route it to <strong>A1/A2</strong> so you can hear it.</li>
                </ol>
            </article>
            <article>
                <h3>3. Target App</h3>
                <ol>
                    <li>Select <strong>Voicemeeter Out B1/B2</strong> as microphone.</li>
                    <li>Keep Gemini's input on your real laptop mic to avoid feedback.</li>
                </ol>
            </article>
        </div>`;
    }

    async function listOutputs() {
        return await window.EveAudioflixAudio?.listOutputs?.() || [];
    }

    async function listNativeOutputs(force) {
        const payload = await window.EveAudioflixNative?.listSystemOutputs?.(force);
        return payload || { devices: [], message: 'Native bridge unavailable.' };
    }

    async function listNativeInputs(force) {
        const payload = await window.EveAudioflixNative?.listSystemInputs?.(force);
        return payload || { devices: [], message: 'Native bridge unavailable.' };
    }

    async function findCableDevice() {
        const devices = await listOutputs();
        return devices.find((device) => isCableLabel(device.label));
    }

    async function populateOutputSelectors(overlay) {
        if (!overlay) return;
        const devices = await listOutputs();
        const snapshot = state();
        const note = overlay.querySelector('[data-af-output-note]');
        if (note) {
            if (!devices.length) {
                note.textContent = 'No browser output list yet. Unlock names or use Windows Mixer.';
            } else if (hasAnonymousOutputs(devices)) {
                note.textContent = 'Names are hidden by browser permission. Unlock once so CABLE Input appears.';
            } else {
                note.textContent = `${devices.length} output device${devices.length === 1 ? '' : 's'} visible.`;
            }
        }
        [
            { selector: '[data-af-control="output-select"]', current: snapshot.preferredSinkId || '' },
            { selector: '[data-af-control="monitor-output-select"]', current: snapshot.geminiVoiceMonitorSinkId || '', blocked: snapshot.preferredSinkId || '', blockCable: true }
        ].forEach(function (entry) {
            const select = overlay.querySelector(entry.selector);
            if (!select) return;
            select.innerHTML = renderBrowserOptions(devices, entry);
            const curDev = devices.find((d) => d.deviceId === entry.current);
            const currentBlocked = (entry.current && entry.current === entry.blocked)
                || (entry.blockCable && curDev && isCableLabel(curDev.label));
            select.value = !hasAnonymousOutputs(devices) && entry.current && !currentBlocked ? entry.current : '';
            // Self-heal a legacy/feedback-prone monitor sink (e.g. a CABLE Input saved before this guard).
            if (entry.blockCable && currentBlocked && entry.current) {
                window.EveAudioflixGemini?.setMonitorSink?.('', 'Default monitor output');
            }
        });
        listNativeOutputs(false).then((payload) => {
            const select = overlay.querySelector('[data-af-control="native-output-select"]');
            const nativeNote = overlay.querySelector('[data-af-native-output-note]');
            const nativeDevices = payload.devices || [];
            if (nativeNote) nativeNote.textContent = payload.message || `${nativeDevices.length} system output device${nativeDevices.length === 1 ? '' : 's'} visible.`;
            if (!select) return;
            if (!nativeDevices.length) {
                const label = payload.status === 404
                    ? 'Audioflix API missing - restart EveOS port'
                    : 'No native output bridge devices found';
                select.innerHTML = `<option value="">${esc(label)}</option>`;
                return;
            }
            select.innerHTML = ['<option value="">Choose native output...</option>'].concat(nativeDevices.map((device) => {
                const playable = device.playable === true;
                const suffix = playable ? '' : ' (discovery only)';
                return `<option value="${esc(device.id)}"${playable ? '' : ' disabled'}>${esc((device.label || device.id) + suffix)}</option>`;
            })).join('');
            select.value = snapshot.nativeOutputId || '';
        }).catch(() => { });
        listNativeInputs(false).then((payload) => {
            const select = overlay.querySelector('[data-af-control="native-input-select"]');
            const nativeNote = overlay.querySelector('[data-af-native-input-note]');
            const nativeDevices = payload.devices || [];
            if (nativeNote) nativeNote.textContent = nativeDevices.length ? 'Mic-side target for the app/game.' : (payload.message || 'No native input targets found.');
            if (!select) return;
            select.innerHTML = ['<option value="">Choose mic target...</option>'].concat(nativeDevices.map((device) => (
                `<option value="${esc(device.id)}">${esc(device.label || device.id)} (reference only)</option>`
            ))).join('');
            select.value = snapshot.nativeInputId || '';
        }).catch(() => { });
    }

    function routeStatusText(playbackStatus) {
        const snapshot = state();
        const audioStatus = window.EveAudioflixAudio?.getStatus?.() || {};
        const geminiStatus = window.EveAudioflixGemini?.getStatus?.() || {};
        const nativeStatus = window.EveAudioflixNative?.getStatus?.() || {};
        const browserCore = browserCoreState(snapshot, audioStatus);
        const attempts = (nativeStatus.attempts || [])
            .slice(-4)
            .map((item) => `- ${item.base || 'unknown'}: ${item.message || item.status || 'checked'}`);
        return [
            'EveOS Audioflix Routing Status',
            `Generated: ${new Date().toISOString()}`,
            '',
            `[Browser Core] ${browserCore.title}`,
            `[Output Router] ${routeLabel(snapshot, audioStatus)}`,
            `[Voice Port] ${snapshot.geminiVoicePortEnabled ? 'selective Gemini WebAudio route armed' : 'default playback'}`,
            `[Route Mode] ${snapshot.routeMode || 'browser'}`,
            `[Native Bridge] ${snapshot.nativeBridgeEnabled ? (snapshot.nativeOutputLabel || snapshot.nativeOutputId || 'enabled') : 'off'}`,
            `[Native Mic Target] ${snapshot.nativeInputLabel || snapshot.nativeInputId || 'not selected'}`,
            `[Native Bridge Status] ${nativeStatus.message || 'not checked'}`,
            `[Local Monitor] ${snapshot.geminiVoiceMonitorEnabled === false ? 'muted' : (snapshot.geminiVoiceMonitorSinkLabel || 'default output')}`,
            `[Conversation Mode] ${snapshot.geminiConversationMode || 'direct-live'}`,
            `[Signal] ${playbackStatus || 'Idle'}`,
            `[Last Gemini Audio] ${geminiStatus.lastEvent ? new Date(geminiStatus.lastEvent.at).toLocaleString() : 'none'}`,
            `[Next Step] ${nextStep(snapshot, audioStatus).title}`,
            '',
            attempts.length ? `[Native Bridge Attempts]\n${attempts.join('\n')}` : '[Native Bridge Attempts] none recorded',
            '',
            'Native bridge route: EveOS server enumerates Windows output endpoints and can receive Gemini PCM chunks, route test tones, and local/served Audioflix WAV clips for EveOS-owned output routing when sounddevice is installed.',
            'Selective browser route: Pick Browser Output/Auto CABLE + Arm uses browser permission and AudioContext.setSinkId when supported, so Gemini WebAudio and Audioflix browser playback can go to VB-CABLE without moving all Edge audio.',
            'Windows mixer route: Settings -> System -> Sound -> Volume mixer -> Edge/EveOS output = CABLE Input.',
            'Target app mic path: CABLE Output -> Voicemeeter strip -> B1/B2 -> target app microphone.'
        ].join('\n');
    }

    async function copyRouteStatus(playbackStatus) {
        const text = routeStatusText(playbackStatus);
        await navigator.clipboard?.writeText?.(text);
        return text;
    }

    Object.assign(ns, {
        ready: true,
        isCableLabel,
        hasAnonymousOutputs,
        renderStatusCards,
        renderRouter,
        populateOutputSelectors,
        findCableDevice,
        copyRouteStatus,
        routeStatusText
    });
})();
