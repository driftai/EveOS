// Recursive group topology shared by Audioflix music and soundboard. Existing flat group arrays
// stay authoritative; the optional parent maps only describe nesting, so old saved states migrate
// as root-only trees without changing membership identity.
window.EveAudioflixGroupTree = window.EveAudioflixGroupTree || {};

(function () {
    'use strict';
    const ns = window.EveAudioflixGroupTree;
    if (ns.ready) return;

    const text = (value) => String(value ?? '').trim();
    const keys = (type) => type === 'music'
        ? { groups: 'musicGroups', parents: 'musicGroupParents', map: 'musicGroupMap', items: 'music' }
        : { groups: 'soundboardGroups', parents: 'soundGroupParents', map: 'soundGroupMap', items: 'soundboard' };
    const names = (state, type) => Array.isArray(state?.[keys(type).groups]) ? state[keys(type).groups] : [];
    const canonical = (groups, value) => {
        const wanted = text(value).toLowerCase();
        return groups.find((name) => text(name).toLowerCase() === wanted) || '';
    };

    function normalizeParents(groups, raw) {
        const list = [...new Set((groups || []).map(text).filter(Boolean))];
        const out = {};
        for (const [childValue, parentValue] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
            const child = canonical(list, childValue), parent = canonical(list, parentValue);
            if (child && parent && child !== parent) out[child] = parent;
        }
        // Break corrupt cycles deterministically at the earliest group in saved display order.
        let changed = true;
        while (changed) {
            changed = false;
            for (const start of list) {
                const seen = new Map(), chain = [];
                let current = start;
                while (current && out[current]) {
                    if (seen.has(current)) {
                        const cycle = chain.slice(seen.get(current));
                        const cut = cycle.sort((a, b) => list.indexOf(a) - list.indexOf(b))[0];
                        delete out[cut];
                        changed = true;
                        break;
                    }
                    seen.set(current, chain.length);
                    chain.push(current);
                    current = out[current];
                }
                if (changed) break;
            }
        }
        return out;
    }

    function parents(state, type) {
        return normalizeParents(names(state, type), state?.[keys(type).parents]);
    }

    function path(state, type, group) {
        const list = names(state, type), clean = canonical(list, group);
        if (!clean) return [];
        const parentMap = parents(state, type), chain = [clean], seen = new Set(chain);
        let current = clean;
        while (parentMap[current] && !seen.has(parentMap[current])) {
            current = parentMap[current];
            seen.add(current);
            chain.push(current);
        }
        return chain.reverse();
    }

    function children(state, type, group = '') {
        const list = names(state, type), parentMap = parents(state, type);
        return list.filter((name) => (parentMap[name] || '') === text(group));
    }

    function descendants(state, type, group) {
        const out = [];
        const visit = (parent) => children(state, type, parent).forEach((child) => {
            out.push(child);
            visit(child);
        });
        visit(canonical(names(state, type), group));
        return out;
    }

    function membershipNames(state, type, group) {
        const clean = canonical(names(state, type), group);
        return clean ? [clean, ...descendants(state, type, clean)] : [];
    }

    function itemsForGroup(state, type, group, sourceItems) {
        const config = keys(type), wanted = new Set(membershipNames(state, type, group));
        const items = Array.isArray(sourceItems) ? sourceItems : (state?.[config.items] || []);
        const map = state?.[config.map] || {};
        return items.filter((item) => (map[item.id] || []).some((name) => wanted.has(canonical(names(state, type), name))));
    }

    function ordered(state, type) {
        const out = [], visited = new Set();
        const visit = (name, depth) => {
            if (visited.has(name)) return;
            visited.add(name);
            out.push({ name, depth, path: path(state, type, name) });
            children(state, type, name).forEach((child) => visit(child, depth + 1));
        };
        children(state, type, '').forEach((root) => visit(root, 0));
        names(state, type).forEach((name) => visit(name, 0));
        return out;
    }

    function deepest(state, type, groups) {
        const direct = [...new Set((groups || []).map((name) => canonical(names(state, type), name)).filter(Boolean))];
        return direct.filter((candidate) => !direct.some((other) => other !== candidate
            && path(state, type, other).slice(0, -1).includes(candidate)));
    }

    function entries(state, type, sourceItems) {
        return ordered(state, type).map(({ name, depth, path: groupPath }) => ({
            name,
            depth,
            path: groupPath,
            members: itemsForGroup(state, type, name, sourceItems),
            hasChildren: children(state, type, name).length > 0
        }));
    }

    function canParent(state, type, child, parent) {
        const list = names(state, type), cleanChild = canonical(list, child), cleanParent = canonical(list, parent);
        if (!cleanChild) return false;
        if (!text(parent)) return true;
        return !!cleanParent && cleanChild !== cleanParent && !descendants(state, type, cleanChild).includes(cleanParent);
    }

    Object.assign(ns, {
        ready: true, keys, names, normalizeParents, parents, path, children, descendants,
        membershipNames, itemsForGroup, ordered, deepest, entries, canParent
    });
})();
