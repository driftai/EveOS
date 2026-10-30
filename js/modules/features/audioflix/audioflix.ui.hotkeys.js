// Soundboard hotkey lifecycle, feedback + focused-page fallback. Bindings follow the selected
// Frontend group only while Soundboard was the last selected Audioflix tab.
// The poll's own timers live here; everything shared with the view (overlay ref, active tab,
// settings-open flag, native-hotkeys-live flag) is reached through the `ctx` accessor facade.
window.EveAudioflixUiHotkeys = window.EveAudioflixUiHotkeys || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixUiHotkeys;
    if (ns.ready) return;

    ns.create = function create(ctx) {
        let hotkeyPollTimer = null, lastFiredAt = 0, hotkeyPollTick = 0, syncPromise = null;
        let appliedFingerprint = '', queuedResync = false, lastStatus = null, localBypassed = false;
        let registeredCombos = new Set(), nativeBypassed = false, nativeBypassReady = false;
        let preparedFingerprint = '', preparedPayload = null;

        const canonicalCombo = (combo) => String(combo || '').split('+').map(part => {
            const key = part.trim().toLowerCase();
            return ({ control: 'ctrl', cmd: 'win', meta: 'win', super: 'win', return: 'enter' })[key] || key;
        }).filter(Boolean).sort().join('+');

        // Surface Audioflix activity in the nexus trace log (no-op if the search monitor isn't up).
        function recordAudioflixNexus(summary) {
            try { window.SearchMonitorBoot?.recordNexusTrace?.({ id: 'af-' + Date.now().toString(36), kind: 'audioflix', summary: String(summary || 'Audioflix activity'), totalMs: 0, endedAt: Date.now() }); } catch (e) {}
        }

        function flashHotkey(itemId) {
            const target = [...(ctx.overlay?.querySelectorAll?.('[data-af-id]') || [])]
                .find(element => element.dataset.afId === String(itemId || ''));
            const card = target?.closest('.audioflix-item-card');
            if (card) { card.classList.add('is-hotkey-hit'); setTimeout(() => card.classList.remove('is-hotkey-hit'), 220); }
        }

        function configuredItems() {
            const seen = new Set();
            return ctx.hotkeySoundItems().filter(item => {
                const id = String(item?.id || ''), combo = String(item?.hotkey || '').trim();
                if (!id || !combo || seen.has(id)) return false;
                seen.add(id); return true;
            });
        }

        const armedItems = () => ctx.activeTab === 'soundboard' ? configuredItems() : [];

        function statusCounts(result) {
            const bindings = Array.isArray(result?.bindings) ? result.bindings : [];
            const registered = Array.isArray(result?.registered)
                ? result.registered.length : bindings.filter(binding => binding?.registered === true).length;
            const conflicts = (Array.isArray(result?.conflicted) ? result.conflicted.length : bindings.filter(binding => binding?.registered === false).length)
                + (Array.isArray(result?.duplicates) ? result.duplicates.length : 0)
                + (result?.bypassConflict ? 1 : 0);
            return { registered, conflicts, configured: Number(result?.configured ?? bindings.length ?? 0) };
        }

        function paintStatus(result) {
            lastStatus = result;
            const counts = statusCounts(result), bypassReady = result?.bypassRegistered === true;
            const localOnly = result?.localOnly === true, localCount = configuredItems().length;
            const standby = ctx.activeTab !== 'soundboard';
            const localBypassConfigured = Boolean(String(ctx.state().hotkeyBypassCombo || '').trim());
            if (!localOnly) {
                const registered = Array.isArray(result?.registered) ? result.registered
                    : (result?.bindings || []).filter(binding => binding?.registered === true).map(binding => binding.combo);
                registeredCombos = new Set(registered.map(canonicalCombo));
                nativeBypassed = result?.bypassed === true; nativeBypassReady = bypassReady;
                ctx.nativeHotkeysLive = result?.ok !== false && (result?.bypassed === true || counts.registered > 0 || bypassReady);
            }
            const el = ctx.overlay?.querySelector('.audioflix-bypass-state');
            if (!el) return;
            const localCapability = `${localCount} sound key${localCount === 1 ? '' : 's'}${localBypassConfigured ? ' + bypass' : ''}`;
            let text = 'NO HOTKEYS SET', state = 'unknown';
            if (localOnly || result?.ok === false) {
                text = localBypassed
                    ? `PAGE BYPASSED — press ${ctx.state().hotkeyBypassCombo || 'bypass'} to re-arm; system-wide unavailable`
                    : `PAGE ONLY — ${localCapability}; system-wide unavailable`;
                state = localBypassed ? 'bypassed' : 'local';
            }
            else if (result?.lastError) { text = `PLAYBACK ERROR — ${result.lastError.message || 'output unavailable'}`; state = 'conflict'; }
            else if (standby && bypassReady) { text = `SOUNDBOARD STANDBY — ${localCount} saved in group; bypass system-wide`; state = 'active'; }
            else if (standby) { text = `SOUNDBOARD STANDBY — ${localCount} saved in group; bypass page-only`; state = 'local'; }
            else if (result?.bypassed === true) { text = `SYSTEM-WIDE BYPASSED — ${counts.configured} suspended`; state = 'bypassed'; }
            else if (counts.conflicts) { text = `PARTIAL — ${counts.registered} armed, ${counts.conflicts} conflict${counts.conflicts === 1 ? '' : 's'}`; state = 'conflict'; }
            else if (counts.registered) { text = `SYSTEM-WIDE — ${counts.registered} armed`; state = 'active'; }
            else if (bypassReady) { text = 'SYSTEM-WIDE BYPASS READY — no sound keys'; state = 'active'; }
            else if (localCount || localBypassConfigured) { text = `PAGE ONLY — ${localCapability}; system-wide not armed`; state = 'local'; }
            el.textContent = text; el.dataset.state = state;
            const toggle = ctx.overlay?.querySelector('[data-af-action="toggle-hotkey-bypass"]');
            if (toggle) {
                const bypassed = localOnly || result?.ok === false ? localBypassed : result?.bypassed === true;
                toggle.textContent = bypassed ? 'Deactivate bypass' : 'Activate bypass';
                toggle.dataset.bypassed = String(bypassed);
                toggle.setAttribute('aria-pressed', String(bypassed));
            }
        }

        async function setBypassed(desired) {
            const next = Boolean(desired);
            try {
                const result = await window.EveAudioflixNative?.setHotkeyBypassed?.(next);
                if (result?.ok !== false) { localBypassed = false; paintStatus(result); return result; }
            } catch (_error) {}
            localBypassed = next;
            const result = { ok: false, localOnly: true, configured: configuredItems().length };
            paintStatus(result); return result;
        }

        async function performSync(force) {
            if (!ctx.hotkeyCatalogReady()) return lastStatus || { ok: false, pending: true };
            const snapshot = ctx.state(), items = armedItems(), bypassCombo = String(snapshot.hotkeyBypassCombo || '').trim();
            const fingerprint = JSON.stringify({ soundboardArmed: ctx.activeTab === 'soundboard', device: snapshot.nativeOutputId || 'default', bypassCombo,
                items: items.map(item => [item.id, item.url, item.hotkey, Number(item.volume ?? 1)]) });
            if (!force && fingerprint === appliedFingerprint && ctx.nativeHotkeysLive) return lastStatus;
            if (!items.length && !bypassCombo) {
                const result = await window.EveAudioflixNative?.clearHotkeys?.();
                appliedFingerprint = fingerprint; paintStatus({ ...(result || {}), configured: 0, bindings: [] }); return result;
            }
            if (preparedFingerprint !== fingerprint) {
                const decoded = await Promise.all(items.map(async item => {
                    try {
                        const buffer = await window.EveAudioflixAudio?.getDecodedBuffer?.(item.url);
                        return buffer ? { item, buffer } : null;
                    } catch (error) { console.error(`Failed to decode hotkey sound ${item.title}:`, error); return null; }
                }));
                const available = decoded.filter(Boolean), sampleRate = available[0]?.buffer?.sampleRate || 48000;
                const bindings = available.map(({ item, buffer }) => ({ combo: String(item.hotkey).trim(),
                    audio: window.EveAudioflixAudio.encodeBufferToBase64(buffer), volume: item.volume ?? 1, voiceId: `hk:${item.id}` }));
                preparedPayload = { deviceId: snapshot.nativeOutputId || 'default', sampleRate, bindings, bypassCombo };
                preparedFingerprint = fingerprint;
            }
            const result = await window.EveAudioflixNative?.setHotkeys?.(preparedPayload);
            const bindings = preparedPayload?.bindings || [];
            const merged = { ...(result || { ok: false }), clientSkipped: items.length - bindings.length };
            appliedFingerprint = merged.ok === false ? '' : fingerprint; paintStatus(merged); return merged;
        }

        function syncHotkeys(options = {}) {
            if (syncPromise) { queuedResync = true; return syncPromise; }
            syncPromise = performSync(options.force === true).catch(error => {
                appliedFingerprint = ''; paintStatus({ ok: false, message: String(error?.message || error) });
                console.error('Failed to synchronize Audioflix hotkeys:', error); return { ok: false };
            }).finally(() => {
                syncPromise = null;
                if (queuedResync) { queuedResync = false; syncHotkeys(); }
            });
            return syncPromise;
        }

        function startHotkeyFeedbackPoll() {
            if (hotkeyPollTimer) return;
            hotkeyPollTick = 0;
            window.EveAudioflixNative?.hotkeyStatus?.().then(r => { lastFiredAt = r?.lastFired?.at || 0; paintStatus(r); }).catch(() => {});
            hotkeyPollTimer = setInterval(() => {
                hotkeyPollTick++;
                const visible = !!ctx.overlay && !ctx.overlay.hidden;
                const onSoundboardFrontend = visible && ctx.activeTab === 'soundboard' && (ctx.state().soundboardViewMode || 'backend') === 'frontend';
                if (!onSoundboardFrontend && !ctx.settingsOpen && hotkeyPollTick % 16 !== 0) return;
                if (!ctx.nativeHotkeysLive) {
                    if (hotkeyPollTick % 120 !== 0) return;
                    syncHotkeys({ force: true });
                    return;
                }
                window.EveAudioflixNative?.hotkeyStatus?.().then(r => {
                    paintStatus(r);
                    if (r?.ok === false || (!r?.bypassed && armedItems().length && statusCounts(r).registered === 0)) syncHotkeys({ force: true });
                    if (!onSoundboardFrontend) return;
                    const lf = r?.lastFired;
                    if (lf?.at && lf.at !== lastFiredAt) {
                        lastFiredAt = lf.at;
                        const card = String(lf.vid || '').startsWith('hk:') && ctx.overlay.querySelector(`.audioflix-item-grid[data-af-active-group] [data-af-id="${lf.vid.slice(3)}"]`)?.closest('.audioflix-item-card');
                        if (card) { card.classList.add('is-hotkey-hit'); setTimeout(() => card.classList.remove('is-hotkey-hit'), 220); }
                        recordAudioflixNexus(`Hotkey ${lf.combo || ''} fired a soundboard clip`);
                    }
                }).catch(() => {});
            }, 250);
        }

        function stopHotkeyFeedbackPoll() { if (hotkeyPollTimer) { clearInterval(hotkeyPollTimer); hotkeyPollTimer = null; } }

        function matchEventToHotkey(e, hotkeyStr) {
            if (!hotkeyStr) return false;
            const parts = hotkeyStr.split('+').map(p => p.trim().toLowerCase());
            let ctrl = parts.includes('ctrl') || parts.includes('control'), alt = parts.includes('alt'), shift = parts.includes('shift'), win = parts.includes('win') || parts.includes('meta') || parts.includes('cmd') || parts.includes('super');
            if (e.ctrlKey !== ctrl || e.altKey !== alt || e.shiftKey !== shift || e.metaKey !== win) return false;
            const main = parts.find(p => !['ctrl', 'control', 'alt', 'shift', 'win', 'meta', 'cmd', 'super'].includes(p)), pk = e.key.toLowerCase();
            return main && (pk === main || (main === 'space' && pk === ' ') || ((main === 'enter' || main === 'return') && pk === 'enter'));
        }

        function handleHotkey(e) {
            if (!ctx.overlay || ctx.overlay.hidden) return;
            // When the system-wide global hook is LIVE (bridge accepted our bindings), it already
            // plays these combos even while focused — running the in-app matcher too would
            // double-fire. But stand down only on confirmed liveness: gating on mere configuration
            // left zero hotkeys on file:// with the server off (bridge armed in state, no process).
            const tag = (e.target?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
            const bypassCombo = ctx.state().hotkeyBypassCombo;
            if (matchEventToHotkey(e, bypassCombo)) {
                if (nativeBypassReady) return;
                e.preventDefault(); localBypassed = !localBypassed;
                paintStatus({ ok: false, localOnly: true, configured: configuredItems().length }); return;
            }
            if (localBypassed || nativeBypassed || ctx.activeTab !== 'soundboard' || ctx.activeInfoItem) return;
            const items = armedItems(), matched = items.find(item => matchEventToHotkey(e, item.hotkey));
            if (!matched) return; e.preventDefault();
            if (registeredCombos.has(canonicalCombo(matched.hotkey))) return;
            flashHotkey(matched.id);
            Promise.resolve(window.EveAudioflixAudio?.playItem?.(matched)).catch(() => {});
        }

        return { startHotkeyFeedbackPoll, stopHotkeyFeedbackPoll, handleHotkey, syncHotkeys, setBypassed, status: () => lastStatus };
    };

    ns.ready = true;
})();
