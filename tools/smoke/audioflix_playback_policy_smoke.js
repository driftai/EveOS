#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const window = {};
const context = vm.createContext({ window, console });
for (const file of [
    'js/modules/features/audioflix/audioflix.state.schema.js',
    'js/modules/features/audioflix/audioflix.playback.policy.js',
    'js/modules/features/audioflix/audioflix.playback.policy.ui.js'
]) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }
function equal(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }

const policy = window.EveAudioflixPlaybackPolicy;
const schema = window.EveAudioflixStateSchema.create({
    text: window.EveAudioflixStateSchema.text,
    normalizeVolume: window.EveAudioflixStateSchema.normalizeVolume,
    id: window.EveAudioflixStateSchema.id
});

const baseState = {
    playbackPolicy: { sourcePreference: 'localized', spotifyMethod: 'managed', outputMode: 'global' },
    playbackScopePolicies: {},
    nativeBridgeEnabled: true,
    nativeOutputId: 'sd:7',
    nativeOutputLabel: 'CABLE Input',
    preferredSinkId: '',
    preferredSinkLabel: '',
    musicGroupMap: {}, soundGroupMap: {}, scopeBindings: []
};
const song = { id: 'track-1', type: 'music', title: 'Track', url: 'https://example.test/t.mp3', localPath: 'C:\\Music\\t.mp3' };

let result = policy.resolve(song, { state: baseState });
equal(result.sourcePreference, 'localized', 'global localized default');
equal(result.spotifyMethod, 'managed', 'managed Spotify default');
equal(result.outputId, 'sd:7', 'global native output');
equal(result.provenance, 'global', 'global provenance');

const groupState = {
    ...baseState,
    activeFrontendMusicGroup: 'Focus',
    musicGroupMap: { 'track-1': ['Other', 'Focus'] },
    playbackScopePolicies: {
        'group:focus': { sourcePreference: 'original', spotifyMethod: 'embed', priority: 1 },
        'group:other': { sourcePreference: 'localized', priority: 999 }
    }
};
result = policy.resolve(song, { state: groupState });
equal(result.scopeKey, 'group:focus', 'active group outranks other memberships');
equal(result.sourcePreference, 'original', 'scope source preference');
equal(result.spotifyMethod, 'embed', 'scope Spotify method');

const priorityState = {
    ...baseState,
    musicGroupMap: { 'track-1': ['Zulu', 'Alpha'] },
    playbackScopePolicies: {
        'group:alpha': { sourcePreference: 'original', priority: 2 },
        'group:zulu': { sourcePreference: 'localized', priority: 3 }
    }
};
equal(policy.resolve(song, { state: priorityState }).scopeKey, 'group:zulu', 'higher priority wins');
priorityState.playbackScopePolicies['group:zulu'].priority = 2;
equal(policy.resolve(song, { state: priorityState }).scopeKey, 'group:alpha', 'tie is lexical and deterministic');

const nexusState = {
    ...baseState,
    scopeBindings: [
        { audioId: 'track-1', audioType: 'music', scopeType: 'workspace', workspaceId: 'main' },
        { audioId: 'track-1', audioType: 'music', scopeType: 'bookmark', workspaceId: 'main', categoryName: 'Music', folderId: 'f', bookmarkId: 'b' }
    ],
    playbackScopePolicies: {
        'nexus:workspace:main:::': { sourcePreference: 'original' },
        'nexus:bookmark:main:music:f:b': { spotifyMethod: 'embed' }
    }
};
equal(policy.resolve(song, { state: nexusState }).scopeKey, 'nexus:bookmark:main:music:f:b', 'specific Nexus scope wins');
nexusState.playbackScopePolicies['nexus:workspace:main:::'].priority = 100;
equal(policy.resolve(song, { state: nexusState }).scopeKey, 'nexus:workspace:main:::', 'priority can override specificity');
equal(policy.resolve(song, { state: nexusState, activeScopeKey: 'nexus:bookmark:main:music:f:b' }).scopeKey,
    'nexus:bookmark:main:music:f:b', 'explicit active Nexus scope wins');

result = policy.resolve({ ...song, playbackPolicy: { scopeMode: 'global' } }, { state: groupState });
equal(result.scopeKey, '', 'song can bypass Nexus scope');
equal(result.sourcePreference, 'localized', 'global bypass uses global source');

result = policy.resolve({ ...song, playbackPolicy: {
    scopeMode: 'custom', sourcePreference: 'original', spotifyMethod: 'embed',
    outputMode: 'custom', outputKind: 'browser', outputId: 'browser-9', outputLabel: 'Headphones'
} }, { state: groupState });
equal(result.sourcePreference, 'original', 'song custom source');
equal(result.spotifyMethod, 'embed', 'song custom Spotify method');
equal(result.outputKind, 'browser', 'song custom output kind');
equal(result.outputId, 'browser-9', 'song custom output id');
equal(result.provenance, 'song+group:focus', 'song provenance retains inherited scope');

result = policy.resolve({ ...song, playbackPolicy: { scopeMode: 'custom', outputMode: 'global' } }, {
    state: { ...groupState, playbackScopePolicies: { 'group:focus': {
        outputMode: 'custom', outputKind: 'browser', outputId: 'scope-device'
    } } }
});
equal(result.outputId, 'sd:7', 'song global output resets inherited custom scope output');
equal(result.outputKind, 'native', 'song global output restores global kind');

let prepared = policy.prepareItem({ ...song, localizations: [{ source: 'group:x', path: 'C:\\x.mp3' }] }, {
    state: { ...baseState, playbackPolicy: { sourcePreference: 'original', spotifyMethod: 'managed' } }
});
equal(prepared.item.localPath, undefined, 'original source strips local path');
equal(prepared.item.localizations.length, 0, 'original source strips localization candidates');
equal(prepared.item._effectivePlaybackPolicy.sourcePreference, 'original', 'effective policy travels with playback item');

prepared = policy.prepareItem(song, { state: baseState });
equal(prepared.item.localPath, song.localPath, 'localized source retains local path');

const cleanedItem = schema.cleanItem({ ...song, playbackPolicy: {
    scopeMode: 'custom', sourcePreference: 'original', spotifyMethod: 'embed',
    outputMode: 'custom', outputKind: 'native', outputId: 'sd:4', outputLabel: 'Cable'
} }, 'music');
equal(cleanedItem.playbackPolicy.outputId, 'sd:4', 'song policy survives normalization');
equal(cleanedItem.playbackPolicy.scopeMode, 'custom', 'song scope mode survives normalization');
check(!Object.prototype.hasOwnProperty.call(schema.cleanItem(song, 'music'), 'playbackPolicy'),
    'default items do not inflate large libraries with policy objects');

const cleanedGlobal = schema.cleanPlaybackPolicy({ sourcePreference: 'bad', spotifyMethod: 'bad' }, { global: true });
equal(cleanedGlobal.sourcePreference, 'localized', 'invalid global source fails safe');
equal(cleanedGlobal.spotifyMethod, 'managed', 'invalid Spotify method fails safe');
equal(schema.cleanPlaybackPolicy({ spotifyMethod: 'electron' }, { global: true }).spotifyMethod, 'embed',
    'retired Electron policy migrates to Official Embed');
equal(policy.bindingKey({ scopeType: 'folder', workspaceId: 'Main', categoryName: 'Music', folderId: 'F1' }),
    'nexus:folder:main:music:f1:', 'Nexus binding key is canonical');

const configuredState = {
    ...baseState,
    music: [{ ...song }],
    soundboard: [{ id: 'sound-1', type: 'sound', title: 'Sound' }]
};
window.EveAudioflixState = {
    ensure: () => configuredState,
    update(patch) { Object.assign(configuredState, patch); },
    updateItem(type, itemId, patch) {
        const list = type === 'sound' ? configuredState.soundboard : configuredState.music;
        Object.assign(list.find((item) => item.id === itemId), patch);
    }
};
equal(policy.configureGlobal({ spotifyMethod: 'embed' }).spotifyMethod, 'embed', 'global policy API normalizes and saves');
equal(configuredState.playbackPolicy.spotifyMethod, 'embed', 'global policy reaches authoritative state');
equal(policy.configureScope('Group:Focus', { sourcePreference: 'original', priority: 5 }).sourcePreference,
    'original', 'scope policy API normalizes and saves');
equal(configuredState.playbackScopePolicies['group:focus'].priority, 5, 'scope policy keeps bounded priority');
equal(policy.configureSong('music', 'track-1', { scopeMode: 'custom', spotifyMethod: 'embed' }).scopeMode,
    'custom', 'song policy API updates one song');
equal(configuredState.music[0].playbackPolicy.spotifyMethod, 'embed', 'song policy persists through state owner');
equal(policy.configureScope('group:focus', null), null, 'scope policy API removes one rule');
equal(policy.configureSong('sound', 'missing', { sourcePreference: 'original' }), null,
    'song policy API refuses an unknown item');

configuredState.musicGroups = ['Focus', 'Night'];
configuredState.music[0].folder = 'Piano';
configuredState.scopeBindings = [{ audioId: 'track-1', audioType: 'music', scopeType: 'workspace', workspaceId: 'main' }];
const policyUi = window.EveAudioflixPlaybackPolicyUi;
const scopeOptions = policyUi.scopeOptions('music', configuredState);
check(scopeOptions.some(entry => entry.key === 'group:focus'), 'policy UI exposes music groups');
check(scopeOptions.some(entry => entry.key === 'folder:piano'), 'policy UI exposes music folders');
check(scopeOptions.some(entry => entry.key === 'nexus:workspace:main:::'), 'policy UI exposes Nexus bindings');
const nexusMarkup = policyUi.renderNexus('music');
check(nexusMarkup.includes('Global defaults') && nexusMarkup.includes('Managed Spotify Engine')
    && nexusMarkup.includes('Official Spotify embed') && !nexusMarkup.includes('Electron Direct Embed'),
    'Nexus panel renders only supported Spotify policy controls');
const songMarkup = policyUi.renderSong(configuredState.music[0], 'music');
check(songMarkup.includes('Decision source') && songMarkup.includes('Effective:'),
    'song settings render policy source and effective decision');
let rerenders = 0;
policyUi.handleChange({
    value: 'original',
    dataset: { afPolicyField: 'sourcePreference', afPolicyLevel: 'scope', afPolicyScope: 'group:focus' }
}, { rerender() { rerenders += 1; } });
equal(configuredState.playbackScopePolicies['group:focus'].sourcePreference, 'original',
    'scope UI change reaches authoritative policy owner');
equal(rerenders, 1, 'scope UI change rerenders once');
policyUi.handleChange({
    value: 'custom',
    dataset: { afPolicyField: 'scopeMode', afPolicyLevel: 'song', afPolicyType: 'music', afPolicyId: 'track-1' }
}, { rerenderModal() { rerenders += 1; } });
equal(configuredState.music[0].playbackPolicy.scopeMode, 'custom', 'song UI selects custom policy mode');
policyUi.handleAction({ dataset: {
    afPolicyLevel: 'song', afPolicyType: 'music', afPolicyId: 'track-1'
} }, 'reset-playback-policy', { rerenderModal() { rerenders += 1; } });
equal(configuredState.music[0].playbackPolicy, undefined, 'song UI reset removes stored override');

console.log(`audioflix playback policy: ${checks}/${checks} checks passed`);
