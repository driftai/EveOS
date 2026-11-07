// User-facing controls for the existing Audioflix playback-policy owner. This module renders and
// edits policy only; transports, queues, Spotify and native output remain owned by their existing
// controllers.
window.EveAudioflixPlaybackPolicyUi = window.EveAudioflixPlaybackPolicyUi || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixPlaybackPolicyUi;
    if (ns.ready) return;
    const text = value => String(value ?? '').trim();
    const esc = value => text(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const selectedScopes = { music: '', sound: '' };

    function state() { return window.EveAudioflixState?.ensure?.() || {}; }
    function policy() { return window.EveAudioflixPlaybackPolicy; }
    function groups(type, snapshot = state()) {
        const names = type === 'sound' ? snapshot.soundboardGroups : snapshot.musicGroups;
        return [...new Set((names || []).map(text).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    }
    function folders(snapshot = state()) {
        return [...new Set((snapshot.music || []).map(item => text(item.folder || item.card)).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
    }
    function scopeOptions(type, snapshot = state()) {
        const options = groups(type, snapshot).map(name => ({ key: `group:${name.toLowerCase()}`, label: `Group · ${name}` }));
        if (type === 'music') folders(snapshot).forEach(name => options.push({ key: `folder:${name.toLowerCase()}`, label: `Folder · ${name}` }));
        (snapshot.scopeBindings || []).filter(binding => binding.audioType === type).forEach(binding => {
            const key = policy()?.bindingKey?.(binding);
            if (key) options.push({ key, label: `Nexus · ${binding.categoryName || binding.folderId || binding.bookmarkId || binding.workspaceId || 'scope'}` });
        });
        return [...new Map(options.map(option => [option.key, option])).values()];
    }
    function activeScope(type, snapshot = state()) {
        const current = type === 'sound'
            ? text(snapshot.activeFrontendGroup)
            : text(snapshot.activeFrontendMusicGroup || snapshot.activeMusicFolderScope);
        const prefix = type === 'music' && !snapshot.activeFrontendMusicGroup && snapshot.activeMusicFolderScope ? 'folder' : 'group';
        return current ? `${prefix}:${current.toLowerCase()}` : '';
    }
    function selectedScope(type, options, snapshot) {
        const remembered = selectedScopes[type];
        if (remembered && options.some(option => option.key === remembered)) return remembered;
        const active = activeScope(type, snapshot);
        if (active && options.some(option => option.key === active)) return active;
        return options[0]?.key || '';
    }
    function valueOf(source, field, fallback) {
        return Object.prototype.hasOwnProperty.call(source || {}, field) ? source[field] : fallback;
    }
    function option(value, label, selected) {
        return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
    }
    function select(level, field, value, entries, extra = '') {
        return `<select data-af-policy-field="${field}" data-af-policy-level="${level}" ${extra}>${entries.map(entry => option(entry[0], entry[1], value)).join('')}</select>`;
    }
    function outputValue(source, inheritValue) {
        if (source?.outputMode === 'custom' && source.outputId) return `${source.outputKind === 'browser' ? 'browser' : 'native'}:${source.outputId}`;
        return source?.outputMode || inheritValue;
    }
    function controls(level, source, meta = {}) {
        const inherit = level === 'global' ? null : ['inherit', 'Inherit'];
        const sourceEntries = [inherit, ['localized', 'Prefer localized copy'], ['original', 'Prefer original URL']].filter(Boolean);
        const spotifyEntries = [inherit, ['managed', 'Managed Spotify Engine'],
            ['electron', 'Electron Direct Embed (Deferred)'], ['embed', 'Official Spotify embed (Edge + native output)']].filter(Boolean);
        const outputEntries = level === 'global'
            ? [['global', 'Follow Audioflix output route']]
            : [['inherit', 'Inherit output policy'], ['global', 'Follow global Audioflix route']];
        const output = outputValue(source, level === 'global' ? 'global' : 'inherit');
        if (source?.outputMode === 'custom' && source.outputId) outputEntries.push([output, source.outputLabel || source.outputId]);
        const attrs = `${meta.type ? `data-af-policy-type="${esc(meta.type)}"` : ''} ${meta.id ? `data-af-policy-id="${esc(meta.id)}"` : ''} ${meta.scope ? `data-af-policy-scope="${esc(meta.scope)}"` : ''}`;
        return `<div class="audioflix-policy-grid">
            <label><span>Source</span>${select(level, 'sourcePreference', valueOf(source, 'sourcePreference', level === 'global' ? 'localized' : 'inherit'), sourceEntries, attrs)}</label>
            <label><span>Spotify</span>${select(level, 'spotifyMethod', valueOf(source, 'spotifyMethod', level === 'global' ? 'managed' : 'inherit'), spotifyEntries, attrs)}</label>
            <label class="audioflix-policy-output"><span>Output port</span>${select(level, 'output', output, outputEntries, `${attrs} data-af-policy-output`)}</label>
        </div>`;
    }
    function effectiveLine(item) {
        const result = policy()?.resolve?.(item) || {};
        const source = result.sourcePreference === 'original' ? 'original URL' : 'localized first';
        const spotify = result.spotifyMethod === 'electron' ? 'Electron direct embed (Deferred)'
            : result.spotifyMethod === 'embed' ? 'official embed' : 'managed engine';
        const output = result.outputLabel || (result.outputKind === 'native' ? 'native route' : 'browser route');
        return `<p class="audioflix-policy-effective"><strong>Effective:</strong> ${esc(source)} · ${esc(spotify)} · ${esc(output)} <span>${esc(result.provenance || 'global')}</span></p>`;
    }
    function renderNexus(type = 'music') {
        type = type === 'sound' ? 'sound' : 'music';
        const snapshot = state(), global = snapshot.playbackPolicy || {};
        const options = scopeOptions(type, snapshot), scope = selectedScope(type, options, snapshot);
        selectedScopes[type] = scope;
        const scoped = snapshot.playbackScopePolicies?.[scope] || {};
        const scopePicker = options.length
            ? `<label class="audioflix-policy-scope"><span>Scope</span><select data-af-policy-scope-picker="${type}">${options.map(entry => option(entry.key, entry.label, scope)).join('')}</select></label>`
            : '<p class="audioflix-policy-empty">Create or select a group/folder to add a scoped policy.</p>';
        const scopeEditor = scope ? `${controls('scope', scoped, { scope })}<button type="button" data-af-action="reset-playback-policy" data-af-policy-level="scope" data-af-policy-scope="${esc(scope)}">Reset scope</button>` : '';
        return `<details class="audioflix-policy-panel" open><summary>Playback policies <span>Global + scoped Nexus routing</span></summary>
            <section><h5>Global defaults</h5>${controls('global', global)}</section>
            <section><h5>${type === 'music' ? 'Music' : 'Soundboard'} scope</h5>${scopePicker}${scopeEditor}</section>
        </details>`;
    }
    function renderSong(item, type = 'music') {
        const stored = item?.playbackPolicy || {}, mode = stored.scopeMode || 'nexus';
        const modeEntries = [['nexus', 'Use matching Nexus scope'], ['global', 'Always use global defaults'], ['custom', 'Customize this item']];
        return `<div class="audioflix-info-groups audioflix-song-policy"><span class="audioflix-info-groups-label">Playback policy</span>
            <label class="audioflix-policy-scope"><span>Decision source</span>${select('song', 'scopeMode', mode, modeEntries, `data-af-policy-type="${esc(type)}" data-af-policy-id="${esc(item.id)}"`)}</label>
            <div${mode === 'custom' ? '' : ' hidden'}>${controls('song', stored, { type, id: item.id })}</div>
            ${effectiveLine(item)}<button type="button" data-af-action="reset-playback-policy" data-af-policy-level="song" data-af-policy-type="${esc(type)}" data-af-policy-id="${esc(item.id)}">Reset item policy</button>
        </div>`;
    }
    function outputPatch(raw) {
        if (raw === 'inherit' || raw === 'global') return { outputMode: raw, outputId: '', outputLabel: '' };
        const split = raw.indexOf(':');
        if (split <= 0) return { outputMode: 'inherit', outputId: '', outputLabel: '' };
        return { outputMode: 'custom', outputKind: raw.slice(0, split) === 'browser' ? 'browser' : 'native', outputId: raw.slice(split + 1) };
    }
    function labelForOutput(target, raw) {
        const selected = [...target.options].find(entry => entry.value === raw);
        return selected?.dataset?.deviceLabel || selected?.textContent || '';
    }
    function apply(level, meta, patch) {
        if (level === 'global') return policy()?.configureGlobal?.(patch);
        if (level === 'scope') return policy()?.configureScope?.(meta.scope, patch);
        return policy()?.configureSong?.(meta.type, meta.id, patch);
    }
    function handleChange(target, ctx) {
        if (target.hasAttribute?.('data-af-policy-scope-picker') || target.dataset?.afPolicyScopePicker) {
            selectedScopes[target.dataset.afPolicyScopePicker === 'sound' ? 'sound' : 'music'] = target.value;
            ctx?.rerender?.(); return true;
        }
        const field = target.dataset?.afPolicyField;
        if (!field) return false;
        const level = target.dataset.afPolicyLevel;
        const meta = { scope: target.dataset.afPolicyScope, type: target.dataset.afPolicyType, id: target.dataset.afPolicyId };
        const patch = field === 'output' ? outputPatch(target.value) : { [field]: target.value };
        if (field === 'output' && patch.outputMode === 'custom') patch.outputLabel = labelForOutput(target, target.value);
        apply(level, meta, patch);
        if (ctx) ctx.playbackStatus = `Playback policy updated (${level}).`;
        level === 'song' ? ctx?.rerenderModal?.() : ctx?.rerender?.();
        return true;
    }
    function handleAction(target, action, ctx) {
        if (action !== 'reset-playback-policy') return false;
        const level = target.dataset.afPolicyLevel;
        if (level === 'scope') policy()?.configureScope?.(target.dataset.afPolicyScope, null);
        else if (level === 'song') policy()?.configureSong?.(target.dataset.afPolicyType, target.dataset.afPolicyId, null);
        else policy()?.configureGlobal?.({ sourcePreference: 'localized', spotifyMethod: 'managed', outputMode: 'global' });
        if (ctx) ctx.playbackStatus = `Playback policy reset (${level}).`;
        level === 'song' ? ctx?.rerenderModal?.() : ctx?.rerender?.();
        return true;
    }
    async function populateOutputs(root) {
        const selects = [...(root?.querySelectorAll?.('[data-af-policy-output]') || [])];
        if (!selects.length) return;
        const [browser, native] = await Promise.all([
            window.EveAudioflixAudio?.listOutputs?.().catch?.(() => []) || [],
            window.EveAudioflixNative?.listSystemOutputs?.(false).catch?.(() => ({ devices: [] })) || { devices: [] }
        ]);
        selects.forEach(selectEl => {
            const current = selectEl.value, known = new Set([...selectEl.options].map(entry => entry.value));
            const append = (kind, device) => {
                const id = text(kind === 'browser' ? device.deviceId : device.id);
                if (!id || (kind === 'native' && device.playable !== true)) return;
                const value = `${kind}:${id}`;
                if (known.has(value)) return;
                const entry = document.createElement('option');
                entry.value = value; entry.textContent = `${kind === 'native' ? 'Native' : 'Browser'} · ${device.label || id}`;
                entry.dataset.deviceLabel = device.label || id; selectEl.appendChild(entry); known.add(value);
            };
            (browser || []).forEach(device => append('browser', device));
            (native?.devices || []).forEach(device => append('native', device));
            if (known.has(current)) selectEl.value = current;
        });
    }

    Object.assign(ns, { ready: true, scopeOptions, activeScope, renderNexus, renderSong, handleChange, handleAction, populateOutputs });
})();
