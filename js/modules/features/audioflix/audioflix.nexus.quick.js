window.EveAudioflixNexusQuick = window.EveAudioflixNexusQuick || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixNexusQuick;
    if (ns.ready) return;
    let dialog = null, type = 'music', scopeMode = 'backend', query = '';

    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const state = () => window.EveAudioflixState?.ensure?.() || {};

    function itemButtonIds(kind) {
        const root = document.querySelector('#audioflix-overlay');
        if (!root) return new Set();
        return new Set([...root.querySelectorAll(`.audioflix-item-grid [data-af-action="play"][data-af-type="${kind}"]`)]
            .map(button => button.dataset.afId).filter(Boolean));
    }

    function scopeFor(kind) {
        const snapshot = state();
        const nexus = window.EveAudioflixNexus;
        const mode = kind === 'music' ? (snapshot.musicViewMode || 'backend') : (snapshot.soundboardViewMode || 'backend');
        const library = nexus?.items?.(kind) || [];
        if (mode !== 'frontend') return { mode, label: 'Backend · whole library', items: library };
        const visibleIds = itemButtonIds(kind);
        const items = library.filter(item => visibleIds.has(item.id));
        const parts = kind === 'music'
            ? [snapshot.activeMusicFolderScope, snapshot.activeFrontendMusicGroup,
                String(snapshot.activeFrontendMusicArtist || '').replace(/^smart:artist:/, ''),
                String(snapshot.activeFrontendMusicClassifier || '').replace(/^class:/, '')].filter(Boolean)
            : [snapshot.activeFrontendGroup].filter(Boolean);
        return { mode, label: `Frontend · ${parts.join(' / ') || 'current visible scope'}`, items };
    }

    function ensureDialog() {
        if (dialog?.isConnected) return dialog;
        dialog = document.createElement('section');
        dialog.className = 'audioflix-nexus-quick';
        dialog.hidden = true;
        dialog.innerHTML = `
            <div class="audioflix-nexus-quick-card" role="dialog" aria-modal="true" aria-labelledby="audioflix-nexus-quick-title">
                <header><div><span>FAST TRACK</span><strong id="audioflix-nexus-quick-title">Nexus song search</strong></div>
                    <button type="button" data-quick-action="close" aria-label="Close fast search">✕</button></header>
                <div class="audioflix-nexus-quick-scope"></div>
                <div class="audioflix-nexus-quick-search">
                    <input type="search" autocomplete="off" spellcheck="false" placeholder="Find a song in this scope…">
                    <button type="button" data-quick-action="open-nexus">Open in Nexus Audio Link</button>
                </div>
                <div class="audioflix-nexus-quick-status" aria-live="polite"></div>
                <div class="audioflix-nexus-quick-results"></div>
            </div>`;
        document.body.appendChild(dialog);
        dialog.addEventListener('input', event => {
            if (!event.target.matches('input[type="search"]')) return;
            query = event.target.value;
            renderResults();
        });
        dialog.addEventListener('click', async event => {
            const button = event.target.closest('[data-quick-action]');
            if (!button) return;
            const action = button.dataset.quickAction, id = button.dataset.afId || '';
            if (action === 'close') return close();
            if (action === 'open-nexus') return openInNexus();
            if (action === 'jump') return jumpToCard(id);
            if (action === 'next') return queueNext(id);
            if (action === 'play') return play(id);
        });
        return dialog;
    }

    function currentMatches() {
        const scope = scopeFor(type);
        scopeMode = scope.mode;
        const matches = String(query || '').trim()
            ? (window.EveAudioflixNexus?.search?.(query, type, scope.items) || []) : [];
        return { scope, matches };
    }

    function meta(item) {
        const groups = window.EveAudioflixNexus?.groupsOf?.(type, item.id) || [];
        return [item.artist, item.folder || item.card || item.category, groups.length ? `Groups: ${groups.join(', ')}` : '']
            .filter(Boolean).join(' · ');
    }

    function resultHtml(item, allowNext, queueEntries) {
        const queueIndex = queueEntries.findIndex(entry => entry.id === item.id);
        const q = queueIndex >= 0 ? `<span class="audioflix-nexus-quick-queue">#${queueIndex + 1} queued</span>` : '';
        return `<article class="audioflix-nexus-quick-row" data-af-id="${esc(item.id)}">
            <div class="audioflix-nexus-quick-copy"><strong>${esc(item.title || 'Untitled')}</strong><span>${esc(meta(item)) || 'No extra metadata'} ${q}</span></div>
            <div class="audioflix-nexus-quick-actions">
                <button type="button" data-quick-action="play" data-af-id="${esc(item.id)}">▶ Play</button>
                ${allowNext ? `<button type="button" data-quick-action="next" data-af-id="${esc(item.id)}">⇥ Play next</button>` : ''}
                <button type="button" data-quick-action="jump" data-af-id="${esc(item.id)}">⌖ Jump to card</button>
            </div></article>`;
    }

    function renderResults() {
        const root = ensureDialog(), { scope, matches } = currentMatches();
        const queue = window.EveAudioflix?.queueConnection?.snapshot?.() || {};
        const allowNext = type === 'music' && scope.mode === 'frontend' && queue.isPlaying === true && queue.currentIndex >= 0;
        root.querySelector('.audioflix-nexus-quick-scope').textContent = `${scope.label} · ${scope.items.length} available`;
        root.querySelector('.audioflix-nexus-quick-status').textContent = query
            ? `${matches.length} match${matches.length === 1 ? '' : 'es'}${allowNext ? ' · Play next follows the active queue.' : ''}`
            : 'Type to search titles, artists, folders, groups, and classifiers.';
        const shown = matches.slice(0, 60);
        root.querySelector('.audioflix-nexus-quick-results').innerHTML = shown.length
            ? shown.map(item => resultHtml(item, allowNext, queue.entries || [])).join('')
            : (query ? '<div class="audioflix-nexus-quick-empty">No matches in this scope.</div>' : '');
        window.EveAudioflixNexus?.recordSearch?.(query, type, matches.length);
    }

    function findTrack(id) {
        return (window.EveAudioflixNexus?.items?.(type) || []).find(item => String(item.id) === String(id)) || null;
    }

    async function play(id) {
        const item = findTrack(id);
        if (!item) return;
        const queue = window.EveAudioflix?.queueConnection;
        const snapshot = queue?.snapshot?.() || {};
        if (type === 'music' && scopeMode === 'frontend' && snapshot.isPlaying) {
            let index = (snapshot.entries || []).findIndex(entry => entry.id === id);
            if (index < 0 && queue?.playNext?.(id)) {
                const next = queue.snapshot();
                index = (next.entries || []).findIndex(entry => entry.id === id);
            }
            if (index >= 0) await queue.jump(index);
            else await window.EveAudioflixAudio?.playItem?.({ ...item, type });
        } else await window.EveAudioflixAudio?.playItem?.({ ...item, type });
        renderResults();
    }

    function queueNext(id) {
        const ok = window.EveAudioflix?.queueConnection?.playNext?.(id);
        ensureDialog().querySelector('.audioflix-nexus-quick-status').textContent = ok
            ? 'Moved into the next queue slot.' : 'Start a frontend group queue before using Play next.';
        renderResults();
    }

    function cardFor(id) {
        return [...document.querySelectorAll('#audioflix-overlay .audioflix-item-card')]
            .find(card => card.querySelector('[data-af-action="play"]')?.dataset.afId === id) || null;
    }

    function jumpToCard(id) {
        close();
        const reveal = () => {
            const card = cardFor(id);
            if (!card) return false;
            const group = card.closest('.audioflix-group.is-collapsed');
            group?.querySelector('.audioflix-group-title')?.click();
            requestAnimationFrame(() => {
                card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                card.classList.add('is-nexus-jump-target');
                setTimeout(() => card.classList.remove('is-nexus-jump-target'), 2200);
            });
            return true;
        };
        if (!reveal()) {
            window.EveAudioflix?.render?.();
            requestAnimationFrame(() => requestAnimationFrame(reveal));
        }
    }

    function openInNexus() {
        const value = query;
        close();
        window.EveAudioflix?.openNexus?.(type);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const input = document.querySelector(`#audioflix-overlay [data-af-nexus-search][data-af-type="${type}"]`);
            if (!input) return;
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus({ preventScroll: true });
        }));
    }

    function open(kind = 'music') {
        type = kind === 'sound' ? 'sound' : 'music';
        query = '';
        const root = ensureDialog();
        root.hidden = false;
        root.querySelector('input').value = '';
        renderResults();
        requestAnimationFrame(() => root.querySelector('input')?.focus({ preventScroll: true }));
    }

    function close() { if (dialog) dialog.hidden = true; }

    document.addEventListener('click', event => {
        const trigger = event.target.closest?.('[data-af-action="open-nexus-quick"], [data-af-action="toggle-nexus"]');
        if (!trigger) return;
        event.preventDefault(); event.stopPropagation();
        if (trigger.dataset.afAction === 'toggle-nexus') window.EveAudioflix?.openNexus?.(trigger.dataset.afType || 'music');
        else open(trigger.dataset.afType || 'music');
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && dialog && !dialog.hidden) { event.preventDefault(); close(); }
    });
    window.addEventListener('eve:audioflix-queue-changed', () => {
        if (dialog && !dialog.hidden) renderResults();
    });

    Object.assign(ns, { ready: true, open, close, render: renderResults });
})();