window.EveAudioflixGroupTreeUi = window.EveAudioflixGroupTreeUi || {};

(function () {
    'use strict';
    const ns = window.EveAudioflixGroupTreeUi;
    if (ns.ready) return;
    const STORE_KEY = 'eveAudioflixExpandedGroupBranchesV1';
    const text = (value) => String(value ?? '').trim();
    let expanded = { music: [], sound: [] };
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        expanded = { music: saved.music || [], sound: saved.sound || [] };
    } catch {}
    const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(expanded)); } catch {} };
    const isOpen = (type, group) => (expanded[type] || []).includes(group);
    const toggle = (type, group) => {
        const values = new Set(expanded[type] || []);
        values.has(group) ? values.delete(group) : values.add(group);
        expanded[type] = [...values];
        save();
    };

    function renderSelector(options = {}) {
        const { type = 'sound', entries = [], active = '', esc = String, bucket = '', filters } = options;
        const byName = new Map(entries.filter((entry) => entry?.name !== 'Ungrouped').map((entry) => [entry.name, entry]));
        const parentMap = window.EveAudioflixGroupTree?.parents?.(options.state || window.EveAudioflixState?.ensure?.() || {}, type) || {};
        const roots = [...byName.values()].filter((entry) => !parentMap[entry.name]);
        const renderNode = (entry) => {
            const children = [...byName.values()].filter((candidate) => parentMap[candidate.name] === entry.name);
            const open = isOpen(type, entry.name);
            const title = entry.path?.length > 1 ? `${entry.path.join(' › ')}. ${filters.pillTitle(entry.name, active, bucket)}` : filters.pillTitle(entry.name, active, bucket);
            const arrow = children.length ? `<button type="button" class="audioflix-group-branch-toggle" data-af-action="toggle-group-branch" data-af-type="${esc(type)}" data-af-group="${esc(entry.name)}" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'} ${esc(entry.name)} subgroups"><span aria-hidden="true">${open ? '▾' : '▸'}</span></button>` : '<span class="audioflix-group-branch-spacer" aria-hidden="true"></span>';
            const marker = entry.depth ? `<span class="audioflix-subgroup-marker" aria-label="Nested group level ${entry.depth}">↳${entry.depth}</span>` : '';
            const pill = `<button type="button" class="audioflix-group-pill${filters.pillClass(entry.name, active, bucket)}" data-af-action="select-frontend-group" data-af-dimension="group" data-af-type="${esc(type)}" data-af-group="${esc(entry.name)}" title="${esc(title)}">${marker}${esc(entry.name)}<span class="audioflix-group-pill-count">${entry.members.length}</span></button>`;
            const nested = children.length ? `<div class="audioflix-group-tree-children"${open ? '' : ' hidden'}>${children.map(renderNode).join('')}</div>` : '';
            return `<div class="audioflix-group-tree-node" style="--af-group-depth:${entry.depth || 0}"><div class="audioflix-group-tree-row">${arrow}${pill}</div>${nested}</div>`;
        };
        const ungrouped = entries.find((entry) => entry?.name === 'Ungrouped');
        const loose = ungrouped ? `<div class="audioflix-group-tree-node"><div class="audioflix-group-tree-row"><span class="audioflix-group-branch-spacer"></span><button type="button" class="audioflix-group-pill${filters.pillClass('Ungrouped', active, bucket)}" data-af-action="select-frontend-group" data-af-dimension="group" data-af-type="${esc(type)}" data-af-group="Ungrouped" title="${esc(filters.pillTitle('Ungrouped', active, bucket))}">Ungrouped<span class="audioflix-group-pill-count">${ungrouped.members.length}</span></button></div></div>` : '';
        return `<div class="audioflix-group-tree" data-af-group-tree="${esc(type)}">${roots.map(renderNode).join('')}${loose}</div>`;
    }

    function renderTags({ type = 'music', groups = [], state, esc = String }) {
        const tree = window.EveAudioflixGroupTree;
        const direct = tree?.deepest?.(state, type, groups) || groups;
        if (!direct.length) return '';
        return `<div class="audioflix-group-tags">${direct.map((group) => {
            const path = tree?.path?.(state, type, group) || [group];
            const depth = Math.max(0, path.length - 1);
            const marker = depth ? `<span class="audioflix-subgroup-marker" aria-hidden="true">↳${depth}</span>` : '';
            return `<button type="button" class="audioflix-group-tag${depth ? ' is-nested' : ''}" data-af-action="select-frontend-group" data-af-dimension="group" data-af-type="${esc(type)}" data-af-group="${esc(group)}" title="${esc(path.join(' › '))}">${marker}${esc(group)}</button>`;
        }).join('')}</div>`;
    }

    document.addEventListener?.('click', (event) => {
        const button = event.target?.closest?.('[data-af-action="toggle-group-branch"]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        toggle(button.dataset.afType === 'music' ? 'music' : 'sound', text(button.dataset.afGroup));
        window.EveAudioflix?.render?.();
    });
    document.addEventListener?.('change', (event) => {
        const select = event.target?.closest?.('[data-af-group-parent]');
        if (!select) return;
        const result = window.EveAudioflixState?.setGroupParent?.(
            select.dataset.afType === 'music' ? 'music' : 'sound',
            select.dataset.afGroup,
            select.value
        );
        if (result?.ok === false) select.value = result.parent || '';
        window.EveAudioflix?.render?.();
    });

    Object.assign(ns, { ready: true, renderSelector, renderTags, isOpen, toggle });
})();
