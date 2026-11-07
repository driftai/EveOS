#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const ASSET_LITERAL_PATTERN = /(["'`])([^"'`\r\n]*?\.(?:js|mjs|css|json|html|part|svg)(?:[?#][^"'`\r\n]*)?)\1/g;
const BROWSER_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.json', '.html', '.part']);
const HTML_ENTRYPOINTS = [
    'EveOS.html',
    'server/audioflix-provider-host.html',
    'server/spotify-embed-edge.html',
    'server/gemini_chat_interface.html',
    'server/server_monitor.html',
    'tools/audioflix/spotify-engine.html',
    'tools/World-Book/app/index.html',
    'tools/workshop/MatrixBackground-V2-Upgrading.html',
    'tools/workshop/fx/codepen_source.html',
    'tools/workshop/fx/fx-showcase.html'
];
const INDIRECT_ENTRYPOINTS = [
    'tools/World-Book/app/fragments/manifest.json',
    'tools/World-Book/app/assets/js/app/chains/manifest.json'
];
let trackedFileCache = null;
const existenceCache = new Map();
const suffixMatchCache = new Map();
const referenceResolutionCache = new Map();

function normalize(relativePath) {
    return String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function absolute(relativePath) {
    return path.join(ROOT, normalize(relativePath).replace(/\//g, path.sep));
}

function exists(relativePath) {
    const normalized = normalize(relativePath);
    if (existenceCache.has(normalized)) return existenceCache.get(normalized);
    const filePath = absolute(normalized);
    const result = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    existenceCache.set(normalized, result);
    return result;
}

function read(relativePath) {
    return fs.readFileSync(absolute(relativePath), 'utf8');
}

function stripQuery(assetPath) {
    return normalize(String(assetPath || '').split(/[?#]/, 1)[0].replace(/^\/+/, ''));
}

function trackedFiles() {
    if (trackedFileCache) return [...trackedFileCache];
    const output = childProcess.execFileSync('git', ['ls-files', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true
    });
    trackedFileCache = output.split('\0').filter(Boolean).map(normalize);
    return [...trackedFileCache];
}

function evaluateMainManifest() {
    const context = vm.createContext({ window: {} });
    const partDirectory = absolute('js/config/manifest/scripts.parts');
    const parts = fs.readdirSync(partDirectory)
        .filter((name) => name.endsWith('.js'))
        .sort((left, right) => left.localeCompare(right));

    for (const name of parts) {
        const relativePath = `js/config/manifest/scripts.parts/${name}`;
        new vm.Script(read(relativePath), { filename: relativePath }).runInContext(context);
    }
    for (const relativePath of [
        'js/config/manifest/scripts.js',
        'js/config/manifest/styles.js',
        'js/config/manifest.js'
    ]) {
        new vm.Script(read(relativePath), { filename: relativePath }).runInContext(context);
    }
    return context.window.EveModuleManifest || { scripts: [], styles: [] };
}

function collectAssetLiterals(source) {
    const literals = [];
    ASSET_LITERAL_PATTERN.lastIndex = 0;
    let match;
    while ((match = ASSET_LITERAL_PATTERN.exec(String(source || '')))) {
        literals.push({
            value: match[2],
            valueStart: match.index + 1,
            valueEnd: match.index + 1 + match[2].length
        });
    }
    return literals;
}

function referenceCandidates(fromRelativePath, reference) {
    const clean = stripQuery(reference);
    if (!clean) return [];
    const from = normalize(fromRelativePath);
    const sourceDirectory = path.posix.dirname(from);
    const candidates = [];
    const add = (value) => {
        const normalized = normalize(path.posix.normalize(value));
        if (normalized && !normalized.startsWith('../') && !candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    };

    if (/^(?:js|css|server|tools)\//i.test(clean)) add(clean);
    if (from.startsWith('tools/World-Book/app/')) add(`tools/World-Book/app/${clean}`);
    if (from.startsWith('server/')) add(`server/${clean}`);
    add(path.posix.join(sourceDirectory, clean));
    add(clean);
    return candidates;
}

function subsystemPrefix(relativePath) {
    const normalized = normalize(relativePath);
    const prefixes = [
        'js/modules/features/scraper/',
        'js/modules/gemini/',
        'js/modules/features/audioflix/',
        'js/modules/features/search-advanced/',
        'tools/World-Book/app/'
    ];
    return prefixes.find((prefix) => normalized.startsWith(prefix)) || '';
}

function sharedDirectoryDepth(leftPath, rightPath) {
    const left = path.posix.dirname(normalize(leftPath)).split('/');
    const right = path.posix.dirname(normalize(rightPath)).split('/');
    let depth = 0;
    while (depth < left.length && depth < right.length && left[depth] === right[depth]) {
        depth++;
    }
    return depth;
}

function resolveUniqueSuffix(fromRelativePath, reference) {
    const interpolated = stripQuery(reference)
        .replace(/\$\{[^}]+\}/g, '')
        .replace(/^\/+/, '');
    const suffix = normalize(interpolated).replace(/^\.\//, '');
    if (!suffix || !/\.(?:js|mjs|css|json|html|part|svg)$/i.test(suffix)) return '';

    let matches = suffixMatchCache.get(suffix);
    if (!matches) {
        matches = trackedFiles().filter((candidate) => (
            exists(candidate) && (candidate === suffix || candidate.endsWith(`/${suffix}`))
        ));
        suffixMatchCache.set(suffix, matches);
    }
    matches = [...matches];
    if (matches.length === 1) return matches[0];

    const subsystem = subsystemPrefix(fromRelativePath);
    if (subsystem && matches.length > 1) {
        matches = matches.filter((candidate) => candidate.startsWith(subsystem));
        if (matches.length === 1) return matches[0];
    }

    if (matches.length > 1) {
        const ranked = matches
            .map((candidate) => ({
                candidate,
                depth: sharedDirectoryDepth(fromRelativePath, candidate)
            }))
            .sort((left, right) => right.depth - left.depth);
        if (ranked[0].depth > ranked[1].depth) return ranked[0].candidate;
    }
    return '';
}

function resolveReference(fromRelativePath, reference) {
    const value = String(reference || '').trim();
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return '';
    const cacheKey = `${normalize(fromRelativePath)}\0${value}`;
    if (referenceResolutionCache.has(cacheKey)) return referenceResolutionCache.get(cacheKey);
    const resolved = referenceCandidates(fromRelativePath, reference).find(exists)
        || resolveUniqueSuffix(fromRelativePath, reference)
        || '';
    referenceResolutionCache.set(cacheKey, resolved);
    return resolved;
}

function manifestAssets() {
    const manifest = evaluateMainManifest();
    return [...(manifest.scripts || []), ...(manifest.styles || [])]
        .map(stripQuery)
        .filter((asset) => asset && exists(asset));
}

function entrypoints() {
    return [...new Set([
        ...HTML_ENTRYPOINTS,
        ...INDIRECT_ENTRYPOINTS,
        ...manifestAssets()
    ].map(normalize).filter(exists))];
}

function buildReachabilityGraph(roots = entrypoints()) {
    const graph = new Map();
    const reachable = new Set();
    const queue = [...new Set(roots.map(normalize).filter(exists))];

    while (queue.length) {
        const current = queue.shift();
        if (reachable.has(current)) continue;
        reachable.add(current);
        if (!BROWSER_SOURCE_EXTENSIONS.has(path.extname(current).toLowerCase())) continue;

        const dependencies = new Set();
        for (const literal of collectAssetLiterals(read(current))) {
            const resolved = resolveReference(current, literal.value);
            if (!resolved) continue;
            dependencies.add(resolved);
            if (!reachable.has(resolved)) queue.push(resolved);
        }
        graph.set(current, [...dependencies].sort());
    }
    return { graph, reachable, roots: [...new Set(roots.map(normalize))] };
}

function runtimeCandidates(files = trackedFiles()) {
    return files.filter((relativePath) => {
        if (!exists(relativePath)) return false;
        const extension = path.extname(relativePath).toLowerCase();
        if (!BROWSER_SOURCE_EXTENSIONS.has(extension)) return false;
        if (/^js\/(?:modules|config|vendor)\//.test(relativePath)) return true;
        if (/^js\/(?:script-loader(?:\.bootstrap)?|style-loader)\.js$/.test(relativePath)) return true;
        if (relativePath.startsWith('css/')) return true;
        if (relativePath.startsWith('server/')) return true;
        if (relativePath.startsWith('tools/audioflix/')) return true;
        if (relativePath.startsWith('tools/World-Book/app/')) return true;
        return relativePath.startsWith('tools/workshop/');
    });
}

module.exports = {
    ASSET_LITERAL_PATTERN,
    BROWSER_SOURCE_EXTENSIONS,
    ROOT,
    absolute,
    buildReachabilityGraph,
    collectAssetLiterals,
    entrypoints,
    evaluateMainManifest,
    exists,
    manifestAssets,
    normalize,
    read,
    resolveReference,
    runtimeCandidates,
    stripQuery,
    trackedFiles
};
