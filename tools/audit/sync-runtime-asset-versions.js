#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    absolute,
    buildReachabilityGraph,
    collectAssetLiterals,
    read,
    resolveReference
} = require('./runtime-asset-graph');

const WRITE = process.argv.includes('--write');
const VERSIONED_EXTENSIONS = new Set(['.js', '.mjs', '.css']);
const MAX_WRITE_PASSES = 8;
const semanticSourceCache = new Map();

function fingerprint(source) {
    return crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
}

function isVersionedAsset(relativePath) {
    return VERSIONED_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function semanticSource(relativePath) {
    if (!semanticSourceCache.has(relativePath)) {
        semanticSourceCache.set(
            relativePath,
            read(relativePath)
                .replace(/\r\n?/g, '\n')
                .replace(/([?&]v=)[^&#"'`\s)]+/g, '$1<asset>')
        );
    }
    return semanticSourceCache.get(relativePath);
}

function stronglyConnectedComponents(nodes, edges) {
    let nextIndex = 0;
    const stack = [];
    const onStack = new Set();
    const indexByNode = new Map();
    const lowLinkByNode = new Map();
    const components = [];

    function visit(node) {
        indexByNode.set(node, nextIndex);
        lowLinkByNode.set(node, nextIndex);
        nextIndex += 1;
        stack.push(node);
        onStack.add(node);

        for (const dependency of edges.get(node) || []) {
            if (!indexByNode.has(dependency)) {
                visit(dependency);
                lowLinkByNode.set(
                    node,
                    Math.min(lowLinkByNode.get(node), lowLinkByNode.get(dependency))
                );
            } else if (onStack.has(dependency)) {
                lowLinkByNode.set(
                    node,
                    Math.min(lowLinkByNode.get(node), indexByNode.get(dependency))
                );
            }
        }

        if (lowLinkByNode.get(node) !== indexByNode.get(node)) return;
        const component = [];
        let member;
        do {
            member = stack.pop();
            onStack.delete(member);
            component.push(member);
        } while (member !== node);
        components.push(component.sort());
    }

    [...nodes].sort().forEach((node) => {
        if (!indexByNode.has(node)) visit(node);
    });
    return components;
}

function buildVersions(graph, reachable) {
    const nodes = new Set([...reachable].filter(isVersionedAsset));
    const edges = new Map([...nodes].map((node) => [
        node,
        (graph.get(node) || []).filter((dependency) => nodes.has(dependency)).sort()
    ]));
    const components = stronglyConnectedComponents(nodes, edges);
    const componentByNode = new Map();
    components.forEach((members, componentIndex) => {
        members.forEach((member) => componentByNode.set(member, componentIndex));
    });

    const componentDependencies = components.map(() => new Set());
    for (const [node, dependencies] of edges) {
        const owner = componentByNode.get(node);
        for (const dependency of dependencies) {
            const target = componentByNode.get(dependency);
            if (target !== owner) componentDependencies[owner].add(target);
        }
    }

    const componentHashes = new Map();
    function hashComponent(componentIndex) {
        if (componentHashes.has(componentIndex)) return componentHashes.get(componentIndex);
        const dependencies = [...componentDependencies[componentIndex]]
            .map((dependencyIndex) => ({
                members: components[dependencyIndex],
                hash: hashComponent(dependencyIndex)
            }))
            .sort((left, right) => left.members[0].localeCompare(right.members[0]));
        const hash = fingerprint(JSON.stringify({
            members: components[componentIndex].map((member) => [member, semanticSource(member)]),
            dependencies
        }));
        componentHashes.set(componentIndex, hash);
        return hash;
    }

    return new Map([...nodes].sort().map((node) => [
        node,
        fingerprint(JSON.stringify({
            path: node,
            source: semanticSource(node),
            component: hashComponent(componentByNode.get(node))
        }))
    ]));
}

function withVersion(reference, version) {
    const hashIndex = reference.indexOf('#');
    const base = hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
    const hash = hashIndex >= 0 ? reference.slice(hashIndex) : '';
    if (/[?&]v=/.test(base)) {
        return base.replace(/([?&]v=)[^&#]*/i, `$1${version}`) + hash;
    }
    return `${base}${base.includes('?') ? '&' : '?'}v=${version}${hash}`;
}

function transform(relativePath, versions) {
    const original = read(relativePath);
    const replacements = [];
    for (const literal of collectAssetLiterals(original)) {
        const dependency = resolveReference(relativePath, literal.value);
        const version = dependency && versions.get(dependency);
        if (!version) continue;
        const nextValue = withVersion(literal.value, version);
        if (nextValue !== literal.value) {
            replacements.push({ start: literal.valueStart, end: literal.valueEnd, value: nextValue });
        }
    }

    let source = original;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
        source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
    }
    return source;
}

function calculate() {
    // --write can rewrite a manifest that is itself fingerprinted by a parent entry point.
    // Never carry semantic source from the previous pass into the next dependency calculation.
    semanticSourceCache.clear();
    const { graph, reachable } = buildReachabilityGraph();
    const versions = buildVersions(graph, reachable);
    const transformed = new Map([...graph.keys()].sort().map((relativePath) => [
        relativePath,
        transform(relativePath, versions)
    ]));
    const stale = [...transformed.entries()]
        .filter(([relativePath, source]) => source !== read(relativePath))
        .map(([relativePath]) => relativePath);
    return { transformed, stale };
}

function main() {
    if (WRITE) {
        const touched = new Set();
        let writes = 0;
        let checked = 0;
        for (let pass = 0; pass < MAX_WRITE_PASSES; pass += 1) {
            const { transformed, stale } = calculate();
            checked = transformed.size;
            if (!stale.length) {
                console.log(`runtime asset versions: synchronized ${touched.size} file(s) in ${writes} pass(es); stable across ${checked} assets`);
                return 0;
            }
            for (const relativePath of stale) {
                fs.writeFileSync(absolute(relativePath), transformed.get(relativePath), 'utf8');
                touched.add(relativePath);
            }
            writes += 1;
        }

        const finalState = calculate();
        if (finalState.stale.length) {
            console.error(`Runtime asset versions did not converge after ${MAX_WRITE_PASSES} passes:`);
            finalState.stale.forEach((relativePath) => console.error(`- ${relativePath}`));
            return 1;
        }
        console.log(`runtime asset versions: synchronized ${touched.size} file(s) in ${writes} pass(es); stable across ${finalState.transformed.size} assets`);
        return 0;
    }

    const { transformed, stale } = calculate();
    if (stale.length) {
        console.error('Runtime asset versions are stale:');
        stale.forEach((relativePath) => console.error(`- ${relativePath}`));
        console.error('\nRun npm run build:asset-versions, then include the generated references in the commit.');
        return 1;
    }
    console.log(`RUNTIME_ASSET_VERSIONS_OK (${transformed.size} assets checked)`);
    return 0;
}

process.exit(main());
