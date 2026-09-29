window.WorldBookNarrationManagerAgentic = window.WorldBookNarrationManagerAgentic || {};

(function (ns) {
    'use strict';

    const bridge = () => window.EveWorldBookNarrationBridge;
    let cacheStats = null;
    let cacheClearQueued = false;
    let bound = false;
    let clearCacheArmedUntil = 0;

    function settings() {
        return bridge()?.settings?.() || { enabled: true, engine: 'browser', geminiVoice: 'Aoede' };
    }

    function humanBytes(bytes) {
        const value = Math.max(0, Number(bytes) || 0);
        if (value < 1024) return `${value} B`;
        if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
        return `${(value / 1024 ** 2).toFixed(1)} MB`;
    }

    function summary(value) {
        if (!value.enabled) return 'Narration is paused. Reader documents and cached audio remain intact.';
        const engine = value.engine === 'gemini' ? `Gemini ${value.geminiVoice || 'voice'}` : 'offline browser speech';
        const route = value.routeToAudioflix
            ? ' through the selected Audioflix output'
            : value.preferNativeOutput !== false ? ' through reliable Windows output when Local Control is available' : '';
        const cache = cacheClearQueued
            ? ' Cache clear queued until World Book is ready.'
            : cacheStats ? ` Cache: ${cacheStats.count || 0} passages / ${humanBytes(cacheStats.bytes)}.` : '';
        return `World Book reads with ${engine}${route}.${cache}`;
    }

    function sync() {
        const value = settings();
        const input = document.getElementById('worldBookNarrationToggle');
        const note = document.querySelector('[data-world-book-narration-note]');
        if (note) note.textContent = summary(value);
        if (input && input.checked !== value.enabled) {
            input.checked = value.enabled;
            if (value.enabled) input.parentElement?.MaterialSwitch?.on?.();
            else input.parentElement?.MaterialSwitch?.off?.();
        }
    }

    function ensureDialog() {
        let dialog = document.getElementById('world-book-narration-settings-dialog');
        if (dialog) return dialog;
        dialog = document.createElement('dialog');
        dialog.id = 'world-book-narration-settings-dialog';
        dialog.className = 'gemini-narration-settings-dialog';
        dialog.innerHTML = `
            <form method="dialog" class="gemini-narration-settings-card">
                <header>
                    <div><span>World Book voice layer</span><h3>Narration Manager</h3></div>
                    <button type="button" data-narration-close aria-label="Close">&times;</button>
                </header>
                <p class="gemini-narration-credential-note">Gemini narration uses the same protected API key saved in Session Controls. No second credential is stored here.</p>
                <div class="gemini-narration-settings-grid">
                    <label><span>Engine</span><select data-narration-field="engine"><option value="browser">Browser speech (offline)</option><option value="gemini">Gemini narration</option></select></label>
                    <label><span>Gemini voice</span><select data-narration-field="geminiVoice"><option>Aoede</option><option>Charon</option><option>Fenrir</option><option>Kore</option><option>Leda</option><option>Orus</option><option>Puck</option><option>Zephyr</option></select></label>
                    <label><span>Rate</span><input data-narration-field="rate" type="number" min="0.5" max="2" step="0.05"></label>
                    <label><span>Pitch</span><input data-narration-field="pitch" type="number" min="0" max="2" step="0.05"></label>
                    <label><span>Volume</span><input data-narration-field="volume" type="number" min="0" max="1" step="0.05"></label>
                    <label><span>Cache limit (MB)</span><input data-narration-field="cacheMb" type="number" min="16" max="1024" step="16"></label>
                    <label><span>Cache retention (days)</span><input data-narration-field="cacheDays" type="number" min="1" max="365" step="1"></label>
                </div>
                <div class="gemini-narration-checks">
                    <label><input data-narration-field="strictVerbatim" type="checkbox"> Read source text verbatim</label>
                    <label><input data-narration-field="backgroundPrefetch" type="checkbox"> Generate the next passage in the background</label>
                    <label><input data-narration-field="preferNativeOutput" type="checkbox"> Prefer audible Windows output when Local Control is available</label>
                    <label><input data-narration-field="routeToAudioflix" type="checkbox"> Route generated narration through Audioflix when its native output is active</label>
                </div>
                <footer>
                    <button type="button" data-narration-clear-cache>Clear generated cache</button>
                    <span></span>
                    <button type="button" data-narration-cancel>Cancel</button>
                    <button type="submit" class="is-primary">Save settings</button>
                </footer>
            </form>`;
        document.body.appendChild(dialog);
        dialog.querySelector('[data-narration-close]').addEventListener('click', () => dialog.close());
        dialog.querySelector('[data-narration-cancel]').addEventListener('click', () => dialog.close());
        dialog.querySelector('[data-narration-clear-cache]').addEventListener('click', event => {
            const button = event.currentTarget;
            if (Date.now() > clearCacheArmedUntil) {
                clearCacheArmedUntil = Date.now() + 5000;
                button.textContent = 'Clear now';
                window.setTimeout(() => {
                    if (Date.now() <= clearCacheArmedUntil || !button.isConnected) return;
                    button.textContent = 'Clear generated cache';
                }, 5100);
                return;
            }
            clearCacheArmedUntil = 0;
            const delivered = bridge()?.broadcastCommand?.('clear-cache') || 0;
            cacheStats = null;
            cacheClearQueued = delivered === 0;
            button.textContent = 'Clear generated cache';
            sync();
        });
        dialog.addEventListener('submit', () => {
            const patch = {};
            dialog.querySelectorAll('[data-narration-field]').forEach(field => {
                const key = field.dataset.narrationField;
                if (field.type === 'checkbox') patch[key] = field.checked;
                else if (field.type === 'number') patch[key] = Number(field.value);
                else patch[key] = field.value;
            });
            bridge()?.saveSettings?.(patch);
            sync();
        });
        return dialog;
    }

    function openSettings() {
        const dialog = ensureDialog();
        const value = settings();
        dialog.querySelectorAll('[data-narration-field]').forEach(field => {
            const current = value[field.dataset.narrationField];
            if (field.type === 'checkbox') field.checked = current === true;
            else field.value = current ?? '';
        });
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    }

    async function loadWorldBookNarrationManagerCard() {
        const placeholder = document.getElementById('world-book-narration-manager-card-placeholder');
        if (!placeholder) throw new Error('World Book Narration Manager placeholder not found.');
        placeholder.innerHTML = `
            <div class="agentic-function-card gemini-agentic-card gemini-agentic-card--narration">
                <div class="gemini-agentic-card-head">
                    <div><div class="gemini-agentic-card-kicker">World Book voice</div><span class="gemini-agentic-card-title">Narration Manager</span></div>
                    <div class="gemini-agentic-card-actions">
                        <button type="button" class="gemini-agentic-icon-btn" data-world-book-narration-settings title="Narration settings" aria-label="Narration settings">&#9881;</button>
                        <label class="mdl-switch mdl-js-switch mdl-js-ripple-effect gemini-agentic-switch" for="worldBookNarrationToggle">
                            <input type="checkbox" id="worldBookNarrationToggle" class="mdl-switch__input"><span class="mdl-switch__label"></span>
                        </label>
                    </div>
                </div>
                <div class="gemini-agentic-card-copy">Read live entries, snapshots, and private imported documents without turning narration into a chat session.</div>
                <button type="button" class="gemini-agentic-secondary-btn" data-world-book-reader-open>Open Reader Library</button>
                <div class="gemini-agentic-card-note" data-world-book-narration-note></div>
            </div>`;
        window.componentHandler?.upgradeElements?.(placeholder);
    }

    function initialize() {
        const input = document.getElementById('worldBookNarrationToggle');
        if (!input) return false;
        if (!input.dataset.bound) {
            input.dataset.bound = '1';
            input.addEventListener('change', () => bridge()?.saveSettings?.({ enabled: input.checked }));
            document.querySelector('[data-world-book-narration-settings]')?.addEventListener('click', openSettings);
            document.querySelector('[data-world-book-reader-open]')?.addEventListener('click', () => bridge()?.openReader?.());
        }
        if (!bound) {
            bound = true;
            window.addEventListener('eve:world-book-narration-settings', sync);
            window.addEventListener('eve:world-book-narration-cache-stats', event => {
                cacheStats = event.detail || null;
                cacheClearQueued = false;
                sync();
            });
        }
        sync();
        return true;
    }

    Object.assign(ns, { ready: true, initialize, openSettings });
    window.loadWorldBookNarrationManagerCard = loadWorldBookNarrationManagerCard;
})(window.WorldBookNarrationManagerAgentic);
