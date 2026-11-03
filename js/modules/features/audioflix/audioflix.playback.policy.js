// One deterministic playback-policy resolver for ordinary Play, Layer Play, queues and Nexus.
// It owns decisions only; existing audio, Spotify and native transports remain the executors.
window.EveAudioflixPlaybackPolicy = window.EveAudioflixPlaybackPolicy || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixPlaybackPolicy;
    if (ns.ready) return;

    const text = value => String(value ?? '').trim();
    const norm = value => text(value).toLowerCase();
    const specificity = key => key.startsWith('nexus:bookmark:') ? 60
        : key.startsWith('nexus:folder:') ? 50
            : key.startsWith('nexus:card:') ? 40
                : key.startsWith('group:') ? 30
                    : key.startsWith('folder:') ? 20
                        : key.startsWith('nexus:workspace:') ? 10 : 0;

    function bindingKey(binding) {
        const b = binding && typeof binding === 'object' ? binding : {};
        const scope = ['workspace', 'card', 'folder', 'bookmark'].includes(b.scopeType)
            ? b.scopeType : 'workspace';
        return [
            'nexus', scope, norm(b.workspaceId || 'main'), norm(b.categoryName),
            norm(b.folderId), norm(b.bookmarkId)
        ].join(':');
    }

    function scopeKeysFor(item, state, context = {}) {
        const requested = text(context.activeScopeKey).toLowerCase();
        const itemId = text(item?.id);
        const type = item?.type === 'sound' ? 'sound' : 'music';
        const map = type === 'sound' ? (state.soundGroupMap || {}) : (state.musicGroupMap || {});
        const activeGroup = type === 'sound' ? state.activeFrontendGroup : state.activeFrontendMusicGroup;
        const groups = [...new Set((map[itemId] || []).map(norm).filter(Boolean))];
        const keys = [];
        if (requested) keys.push(requested);
        if (activeGroup && groups.includes(norm(activeGroup))) keys.push(`group:${norm(activeGroup)}`);
        (state.scopeBindings || [])
            .filter(binding => text(binding.audioId) === itemId && binding.audioType === type)
            .map(bindingKey).forEach(key => keys.push(key));
        groups.sort().forEach(group => keys.push(`group:${group}`));
        const folder = norm(item?.folder || item?.card || item?.category);
        if (folder) keys.push(`folder:${folder}`);
        return [...new Set(keys)];
    }

    function chooseScopePolicy(item, state, context = {}) {
        const policies = state.playbackScopePolicies || {};
        const keys = scopeKeysFor(item, state, context);
        const requested = norm(context.activeScopeKey);
        const activeGroup = item?.type === 'sound' ? state.activeFrontendGroup : state.activeFrontendMusicGroup;
        const preferredKey = requested || (activeGroup ? `group:${norm(activeGroup)}` : '');
        const candidates = keys.map(key => ({ key, policy: policies[key] }))
            .filter(candidate => candidate.policy && typeof candidate.policy === 'object')
            .sort((left, right) => {
                const leftRequested = left.key === preferredKey ? 1 : 0;
                const rightRequested = right.key === preferredKey ? 1 : 0;
                if (leftRequested !== rightRequested) return rightRequested - leftRequested;
                const priority = Number(right.policy.priority || 0) - Number(left.policy.priority || 0);
                if (priority) return priority;
                const rank = specificity(right.key) - specificity(left.key);
                return rank || left.key.localeCompare(right.key);
            });
        return candidates[0] || null;
    }

    function globalDecision(state) {
        const policy = state.playbackPolicy || {};
        const custom = policy.outputMode === 'custom' && text(policy.outputId);
        const outputKind = custom ? policy.outputKind : (state.nativeBridgeEnabled ? 'native' : 'browser');
        const outputId = custom ? text(policy.outputId)
            : outputKind === 'native' ? text(state.nativeOutputId) : text(state.preferredSinkId);
        const outputLabel = custom ? text(policy.outputLabel)
            : outputKind === 'native' ? text(state.nativeOutputLabel) : text(state.preferredSinkLabel);
        return {
            sourcePreference: policy.sourcePreference === 'original' ? 'original' : 'localized',
            spotifyMethod: ['embed', 'electron'].includes(policy.spotifyMethod) ? policy.spotifyMethod : 'managed',
            outputMode: custom ? 'custom' : 'global', outputKind, outputId, outputLabel
        };
    }

    function mergeDecision(base, policy) {
        const next = { ...base };
        if (policy?.sourcePreference && policy.sourcePreference !== 'inherit') next.sourcePreference = policy.sourcePreference;
        if (policy?.spotifyMethod && policy.spotifyMethod !== 'inherit') next.spotifyMethod = policy.spotifyMethod;
        if (policy?.outputMode === 'global') {
            next.outputMode = 'global';
        } else if (policy?.outputMode === 'custom' && text(policy.outputId)) {
            next.outputMode = 'custom';
            next.outputKind = policy.outputKind === 'browser' ? 'browser' : 'native';
            next.outputId = text(policy.outputId);
            next.outputLabel = text(policy.outputLabel);
        }
        return next;
    }

    function resolve(item, context = {}) {
        const state = context.state || window.EveAudioflixState?.ensure?.() || {};
        const global = globalDecision(state);
        const song = item?.playbackPolicy && typeof item.playbackPolicy === 'object'
            ? item.playbackPolicy : {};
        const scopeMode = ['global', 'custom'].includes(song.scopeMode) ? song.scopeMode : 'nexus';
        const selected = scopeMode === 'global' ? null : chooseScopePolicy(item, state, context);
        let effective = selected ? mergeDecision(global, selected.policy) : { ...global };
        if (scopeMode === 'custom') {
            if (song.outputMode === 'global') {
                effective.outputMode = global.outputMode;
                effective.outputKind = global.outputKind;
                effective.outputId = global.outputId;
                effective.outputLabel = global.outputLabel;
            }
            effective = mergeDecision(effective, song);
        }
        return {
            ...effective,
            scopeMode,
            scopeKey: selected?.key || '',
            provenance: scopeMode === 'global' ? 'global'
                : scopeMode === 'custom' ? `song${selected ? `+${selected.key}` : ''}`
                    : selected?.key || 'global'
        };
    }

    function originalSourceItem(item) {
        const value = item && typeof item === 'object' ? { ...item } : {};
        delete value.localPath;
        value.localizations = [];
        return value;
    }

    function prepareItem(item, context = {}) {
        const policy = resolve(item, context);
        const source = policy.sourcePreference === 'original' ? originalSourceItem(item) : { ...(item || {}) };
        source._effectivePlaybackPolicy = policy;
        return { item: source, policy };
    }

    function cleaner() {
        const schema = window.EveAudioflixStateSchema;
        return schema?.create?.({ text: schema.text, normalizeVolume: schema.normalizeVolume, id: schema.id });
    }

    function configureGlobal(patch = {}) {
        const store = window.EveAudioflixState;
        const current = store?.ensure?.()?.playbackPolicy || {};
        const next = cleaner()?.cleanPlaybackPolicy?.({ ...current, ...patch }, { global: true });
        if (!next) return null;
        store.update({ playbackPolicy: next }, 'audioflix-playback-policy-global');
        return next;
    }

    function configureScope(scopeKey, patch) {
        const key = norm(scopeKey);
        if (!key) return null;
        const store = window.EveAudioflixState, state = store?.ensure?.() || {};
        const policies = { ...(state.playbackScopePolicies || {}) };
        if (patch === null) delete policies[key];
        else {
            const next = cleaner()?.cleanPlaybackPolicy?.({ ...(policies[key] || {}), ...(patch || {}) }, { partial: true });
            if (next && Object.keys(next).length) policies[key] = next; else delete policies[key];
        }
        store.update({ playbackScopePolicies: policies }, 'audioflix-playback-policy-scope');
        return policies[key] || null;
    }

    function configureSong(type, itemId, patch) {
        const store = window.EveAudioflixState;
        const state = store?.ensure?.() || {};
        const key = type === 'sound' ? 'soundboard' : 'music';
        const item = (state[key] || []).find(entry => text(entry?.id) === text(itemId));
        if (!item) return null;
        const playbackPolicy = patch === null ? undefined
            : cleaner()?.cleanPlaybackPolicy?.({ ...(item.playbackPolicy || {}), ...(patch || {}) });
        store.updateItem(type, itemId, { playbackPolicy }, { reason: 'audioflix-playback-policy-song' });
        return playbackPolicy || null;
    }

    Object.assign(ns, {
        ready: true,
        bindingKey,
        scopeKeysFor,
        chooseScopePolicy,
        resolve,
        prepareItem,
        configureGlobal,
        configureScope,
        configureSong,
        policyOf(item) { return item?._effectivePlaybackPolicy || resolve(item); }
    });
})();
