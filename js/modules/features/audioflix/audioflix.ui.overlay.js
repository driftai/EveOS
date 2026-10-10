// Overlay construction + event wiring for the Audioflix panel: builds the root element once and
// attaches the delegated click / submit / input / change listeners plus the queue-advance hook.
// Split out of audioflix.ui.js to keep that view under the project line cap. Everything it touches
// (handlers, renderers, mutable flags) arrives late-bound through the `ctx` bag.
window.EveAudioflixUiOverlay = window.EveAudioflixUiOverlay || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixUiOverlay;
    if (ns.ready) return;

    ns.create = function create(ctx) {
        const { state, rerender, close, handleAction, handleForm, handleHotkey,
            startHotkeyFeedbackPoll, renderPanel, shuffleQueue, uiNexus, uiClass, findItem,
            pushHotkeysToBridge, hotkeyComboIssue } = ctx;
        // Shared mutable view state stays in audioflix.ui.js; reach it through the accessor bag.
        const V = ctx.view;

        // Provider-backed players can report their terminal state while EveOS is backgrounded.
        // Register this bridge before audioflix.ui.js installs its generic Ended listener so the
        // provider can move the existing queue immediately without waiting for a foreground render.
        // Official Spotify embeds report terminal state through the browser-provider path. Key the
        // fast-path on Spotify provenance too so imported items advance even across old snapshots.
        // The generic listener remains the fallback; its queueRunId guard sees the step below and
        // therefore cannot skip a second track. Repeat-one stays with the generic restart path.
        let providerAdvancePending = '';
        window.addEventListener('eve:audioflix-playback', (event) => {
            const detail = event.detail || {};
            const spotifyBacked = detail.provider === 'spotify'
                || String(detail.item?.sourceProvider || '').toLowerCase() === 'spotify'
                || !!detail.item?.spotifyUrl;
            if (detail.status !== 'Ended' || detail.browserOnly !== true || !spotifyBacked) return;
            const bridge = window.EveAudioflix?.queueConnection;
            const snapshot = bridge?.snapshot?.();
            if (!snapshot?.isPlaying || snapshot.repeatOne || !snapshot.entries?.length) return;
            if (window.EveAudioflixQueueCompletion?.isStaleDelivery?.(detail, snapshot.playbackRunId)) return;
            const expectedIndex = Number(snapshot.currentIndex);
            const expectedItem = snapshot.entries[expectedIndex];
            if (!Number.isInteger(expectedIndex) || expectedIndex < 0 || !expectedItem) return;
            const eventId = String(detail.item?.id ?? '');
            const expectedId = String(expectedItem.id ?? '');
            const expectedRunId = snapshot.playbackRunId;
            if (eventId && eventId !== expectedId) return;
            const key = `${expectedId}:${expectedRunId}`;
            if (providerAdvancePending === key) return;
            providerAdvancePending = key;
            Promise.resolve(detail.settle).catch(() => false).then(() => {
                const latestBridge = window.EveAudioflix?.queueConnection;
                const latest = latestBridge?.snapshot?.();
                const latestItem = latest?.entries?.[latest.currentIndex];
                if (!latest?.isPlaying || latest.repeatOne
                    || latest.playbackRunId !== expectedRunId
                    || String(latestItem?.id ?? '') !== expectedId) return false;
                return latestBridge.step?.(1);
            }).finally(() => {
                if (providerAdvancePending === key) providerAdvancePending = '';
            });
        });

        function ensureOverlay() {
            if (V.overlay) return V.overlay;
            V.overlay = Object.assign(document.createElement('div'), { id: 'audioflix-overlay', className: 'audioflix-overlay', hidden: true });
            document.body.appendChild(V.overlay);
            const removeUngroupedMenu = () => V.overlay?.querySelector('.audioflix-context-menu')?.remove();
            V.overlay.addEventListener('click', e => {
                const t = e.target, act = t.closest('[data-af-action]');
                if (!t.closest('.audioflix-context-menu')) removeUngroupedMenu();
                if (act) {
                    if (act.classList.contains('audioflix-info-modal') && t.closest('.audioflix-info-card')) return;
                    e.preventDefault();
                    if (act.dataset.afAction === 'close') close(); else handleAction(act, e);
                } else if (t === V.overlay) close();
            });
            V.overlay.addEventListener('contextmenu', e => {
                const header = e.target.closest('.audioflix-group-title[data-af-context="ungrouped"]');
                if (!header) return;
                e.preventDefault();
                removeUngroupedMenu();
                const type = header.dataset.afType === 'music' ? 'music' : 'sound';
                const count = Math.max(0, Number(header.dataset.afClearCount || 0) || 0);
                if (!count) return;
                const menu = document.createElement('div');
                menu.className = 'audioflix-context-menu';
                menu.setAttribute('role', 'menu');
                menu.innerHTML = `<strong>Ungrouped</strong><span>${count} ${type === 'music' ? 'track' : 'sound'}${count === 1 ? '' : 's'}</span><button type="button" role="menuitem" data-af-action="clear-ungrouped" data-af-type="${type}">Clear Ungrouped</button><small>Removes these entries from Audioflix. Source files on disk are kept.</small>`;
                menu.style.left = `${Math.max(8, e.clientX)}px`;
                menu.style.top = `${Math.max(8, e.clientY)}px`;
                V.overlay.appendChild(menu);
                requestAnimationFrame(() => {
                    const box = menu.getBoundingClientRect();
                    if (box.right > window.innerWidth - 8) menu.style.left = `${Math.max(8, window.innerWidth - box.width - 8)}px`;
                    if (box.bottom > window.innerHeight - 8) menu.style.top = `${Math.max(8, window.innerHeight - box.height - 8)}px`;
                    menu.querySelector('button')?.focus({ preventScroll: true });
                });
            });
            V.overlay.addEventListener('submit', e => { e.preventDefault(); const f = e.target.closest('form[data-af-form]'); if (f) handleForm(f); });
            V.overlay.addEventListener('input', e => {
                const t = e.target;
                if (window.EveAudioflixSoundLabUi?.handleInput?.(t, e)) return;
                if (window.EveAudioflixOutputPort?.handleInput?.(t)) return;
                if (t.hasAttribute && t.hasAttribute('data-af-nexus-search')) {
                    // Live search: refresh only the results container so the input keeps focus.
                    V.nexusState = { ...V.nexusState, query: t.value };
                    const box = V.overlay.querySelector(`.audioflix-nexus-results[data-af-nexus-results="${t.dataset.afType}"]`);
                    if (box) box.innerHTML = uiNexus.renderResults(t.dataset.afType);
                    const matchCounter = V.overlay.querySelector('[data-af-bulk-match-count]');
                    if (matchCounter) matchCounter.textContent = String(uiNexus.getLastMatchCount?.(t.dataset.afType) || 0);
                    return;
                }
                if (t.hasAttribute && t.hasAttribute('data-af-spotify-search')) {
                    const query = String(t.value || '').trim().toLowerCase();
                    t.closest('[data-af-spotify-inspector]')?.querySelectorAll('[data-af-spotify-row]').forEach((row) => {
                        row.hidden = !!query && !String(row.dataset.afSearch || '').includes(query);
                    });
                    return;
                }
                if (t.hasAttribute && t.hasAttribute('data-af-bulk-field')) {
                    V.nexusState = {
                        ...V.nexusState,
                        bulk: {
                            ...(V.nexusState.bulk || {}),
                            [t.dataset.afBulkField]: t.value
                        }
                    };
                    return;
                }
                if (t.classList.contains('audioflix-seek-slider')) {
                    window.EveAudioflixTransport?.preview?.(t);
                } else if (t.classList.contains('audioflix-volume-slider')) {
                    const vol = parseFloat(t.value), id = t.dataset.afId, lbl = t.nextElementSibling;
                    t.style.setProperty('--vol', `${vol * 100}%`); if (lbl) lbl.textContent = `${Math.round(vol * 100)}%`;
                    // data-* values are always strings, while imported/localized records may keep a
                    // numeric ID. Hand the playback layer its real active ID when the values are
                    // equivalent so its active-item update cannot silently miss the live player.
                    const activeId = window.EveAudioflixAudio?.getPlaybackState?.()?.item?.id;
                    const playbackId = String(activeId ?? '') === String(id ?? '') ? activeId : id;
                    window.EveAudioflixAudio?.updateItemVolume?.(playbackId, vol);
                    window.EveAudioflixState?.setItemVolume?.(t.dataset.afType, id, vol);
                    const ps = V.portedSounds.find(s => String(s.id ?? '') === String(id ?? '')); if (ps) ps.volume = vol;
                }
            });
            V.overlay.addEventListener('change', async e => {
                const t = e.target, id = t.dataset.afId, type = t.dataset.afType || 'sound';
                if (window.EveAudioflixOutputPort?.handleChange?.(t)) return;
                if (await window.EveAudioflixSoundLabUi?.handleChange?.(t, e)) return;
                if (t.classList.contains('audioflix-nexus-select')) {
                    const selected = new Set(V.nexusState.selectedIds || []);
                    if (t.checked) selected.add(id); else selected.delete(id);
                    t.closest('.audioflix-nexus-row')?.classList.toggle('is-selected', t.checked);
                    const counter = V.overlay.querySelector('[data-af-bulk-selected-count]');
                    if (counter) counter.textContent = String(selected.size);
                } else if (t.hasAttribute && t.hasAttribute('data-af-bulk-field')) {
                    V.nexusState = {
                        ...V.nexusState,
                        bulk: {
                            ...(V.nexusState.bulk || {}),
                            [t.dataset.afBulkField]: t.value
                        }
                    };
                } else if (t.classList.contains('audioflix-seek-slider')) {
                    await window.EveAudioflixAudio?.seek?.(Number(t.value || 0));
                    window.EveAudioflixTransport?.finishSeek?.(t);
                    window.EveAudioflixTransport?.sync?.(V.overlay);
                } else if (t.classList.contains('audioflix-expose-cb')) {
                    window.EveAudioflixState?.setItemExposed?.(type, id, t.checked);
                    if (V.activeInfoItem?.id === id) V.activeInfoItem.exposed = t.checked;
                    const ps = V.portedSounds.find(s => s.id === id); if (ps) ps.exposed = t.checked;
                    pushHotkeysToBridge();
                    rerender();
                } else if (t.classList.contains('audioflix-provider-transport-toggle')) {
                    window.EveAudioflixState?.updateItem?.('music', id, {
                        showProviderTransport: t.checked
                    });
                    if (V.activeInfoItem?.id === id) V.activeInfoItem.showProviderTransport = t.checked;
                    const activeId = window.EveAudioflixAudio?.getPlaybackState?.()?.item?.id;
                    if (String(activeId || '') === String(id || '')) {
                        document.querySelector('.audioflix-provider-stage.is-transport-only')
                            ?.classList.toggle('is-transport-hidden', !t.checked);
                    }
                } else if (t.classList.contains('audioflix-localization-path')) {
                    const res = window.EveAudioflixLocalize?.setLocalizationPath?.(t.dataset.afId, t.dataset.afSource, t.value);
                    V.playbackStatus = res?.ok ? 'Localization path updated.' : (res?.reason || 'Could not update that path.');
                    rerender();
                } else if (t.classList.contains('audioflix-marker-toggle')) {
                    window.EveAudioflixState?.update?.({ showPlaylistMarkersOnCard: t.checked }, 'audioflix-marker-visibility');
                    rerender();
                } else if (t.classList.contains('audioflix-local-marker-toggle')) {
                    window.EveAudioflixState?.update?.({ showLocalMissingMarkersOnCard: t.checked }, 'audioflix-local-marker-visibility');
                    rerender();
                } else if (t.classList.contains('audioflix-classifier-cb')) {
                    window.EveAudioflixClassifiers?.toggleOnTrack?.(t.dataset.afId, t.dataset.afClassifier, t.checked);
                    rerender();
                } else if (t.classList.contains('audioflix-group-cb')) {
                    if (type === 'music') {
                        window.EveAudioflixState?.toggleMusicGroup?.(id, t.dataset.afGroup, t.checked);
                        window.EveAudioflix?.queueConnection?.syncGroupMembership?.(id, t.dataset.afGroup, t.checked);
                    } else window.EveAudioflixState?.toggleSoundGroup?.(id, t.dataset.afGroup, t.checked);
                    pushHotkeysToBridge();
                } else if (t.classList.contains('audioflix-hotkey-input')) {
                    const val = t.value.trim().toLowerCase(), issue = hotkeyComboIssue(val);
                    t.title = issue ? issue.msg : 'Global hotkey (e.g. ctrl+y)'; t.classList.toggle('audioflix-input-invalid', !!(issue && issue.invalid));
                    if (issue) V.playbackStatus = issue.msg;
                    window.EveAudioflixState?.setItemHotkey?.(type, id, val);
                    if (V.activeInfoItem?.id === id) V.activeInfoItem.hotkey = val;
                    const ps = V.portedSounds.find(s => s.id === id); if (ps) ps.hotkey = val;
                    pushHotkeysToBridge();
                } else if (t.classList.contains('audioflix-bypass-input')) {
                    const val = t.value.trim().toLowerCase(), issue = hotkeyComboIssue(val);
                    t.title = issue ? issue.msg : 'Press this to suspend/resume all sound hotkeys'; t.classList.toggle('audioflix-input-invalid', !!(issue && issue.invalid));
                    window.EveAudioflixState?.update?.({ hotkeyBypassCombo: val }, 'audioflix-bypass'); pushHotkeysToBridge();
                } else {
                    const sel = t.closest('[data-af-control]'); if (!sel) return;
                    const lbl = sel.selectedOptions[0]?.textContent || '', val = sel.value || '', ctrl = sel.dataset.afControl; sel.blur();
                    try {
                        if (ctrl === 'monitor-output-select') {
                            const isVoicePort = val && state().preferredSinkId === val;
                            if (val && window.EveAudioflixRouting?.isCableLabel?.(lbl)) {
                                V.playbackStatus = 'Monitor can’t use a CABLE Input — that loops Gemini voice back into the mic. Pick real speakers/headphones.';
                                window.EveAudioflixGemini?.setMonitorSink?.('', 'Default monitor output');
                            } else window.EveAudioflixGemini?.setMonitorSink?.(isVoicePort ? '' : val, isVoicePort ? 'Default monitor output' : lbl);
                        }
                        else if (ctrl === 'output-select') {
                            await window.EveAudioflixAudio?.setOutputById?.(val, lbl);
                            if (val && state().geminiVoiceMonitorSinkId === val) window.EveAudioflixGemini?.setMonitorSink?.('', 'Default monitor output');
                        } else if (ctrl === 'native-output-select') { window.EveAudioflixNative?.selectNativeOutput?.(val, lbl.replace(/\s+\(discovery only\)$/i, '')); pushHotkeysToBridge(); }
                        else if (ctrl === 'native-input-select') window.EveAudioflixNative?.selectNativeInput?.(val, lbl.replace(/\s+\(reference only\)$/i, ''));
                    } catch (err) { V.playbackStatus = err.message || 'Output selection failed'; }
                    rerender();
                }
            });
            document.addEventListener('keydown', handleHotkey);

            return V.overlay;
        }
        return ensureOverlay;
    };

    ns.ready = true;
})();
