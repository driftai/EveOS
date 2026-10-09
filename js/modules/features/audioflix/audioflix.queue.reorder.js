window.EveAudioflixQueueReorder = window.EveAudioflixQueueReorder || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixQueueReorder;
    if (ns.ready) return;
    let dragIndex = -1;
    let dragList = null;

    // Every internal-player stage (linked audio, managed Spotify engine, ...) renders the same
    // queue list, so each one gets the same row controls. Indexes are scoped to the row's own list.
    function rows(from) {
        const list = from?.closest?.('.audioflix-provider-queue-list');
        return list ? [...list.children] : [];
    }

    function enhance() {
        document.querySelectorAll('.audioflix-provider-queue-list').forEach(enhanceList);
    }

    function enhanceList(list) {
        const all = [...list.children];
        all.forEach((row, index) => {
            if (!(row instanceof HTMLElement)) return;
            row.dataset.queueIndex = String(index);
            row.draggable = false;
            const main = row.querySelector('[data-url-player-action="queue-jump"]');
            if (main) main.classList.add('audioflix-queue-entry-main');
            if (!row.querySelector('.audioflix-queue-drag-handle')) {
                const grip = document.createElement('span');
                grip.className = 'audioflix-queue-drag-handle';
                grip.textContent = '⋮⋮';
                grip.title = 'Drag to reorder';
                grip.draggable = true;
                grip.setAttribute('aria-hidden', 'true');
                row.prepend(grip);
            }
            if (!row.querySelector('.audioflix-queue-order-buttons')) {
                const tools = document.createElement('span');
                tools.className = 'audioflix-queue-order-buttons';
                tools.innerHTML = '<button type="button" data-queue-move="-1" title="Move up" aria-label="Move track up">↑</button><button type="button" data-queue-move="1" title="Move down" aria-label="Move track down">↓</button>';
                row.append(tools);
            }
            const controls = row.querySelectorAll('[data-queue-move]');
            if (controls[0]) controls[0].disabled = index === 0;
            if (controls[1]) controls[1].disabled = index === all.length - 1;
        });
    }

    document.addEventListener('click', event => {
        const button = event.target.closest?.('[data-queue-move]');
        if (!button) return;
        event.preventDefault(); event.stopPropagation();
        const row = button.closest('.audioflix-provider-queue-list > li');
        const index = rows(row).indexOf(row);
        const delta = Number(button.dataset.queueMove) || 0;
        if (index >= 0 && delta) window.EveAudioflix?.queueConnection?.move?.(index, index + delta);
    }, true);

    document.addEventListener('dragstart', event => {
        const row = event.target.closest?.('.audioflix-provider-queue-list > li');
        if (!row) return;
        if (!event.target.closest?.('.audioflix-queue-drag-handle')) return;
        dragIndex = rows(row).indexOf(row);
        dragList = row.parentElement;
        row.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', String(dragIndex)); } catch {}
    });

    document.addEventListener('dragover', event => {
        const row = event.target.closest?.('.audioflix-provider-queue-list > li');
        if (!row || dragIndex < 0 || row.parentElement !== dragList) return;
        event.preventDefault();
        rows(row).forEach(item => item.classList.toggle('is-drop-target', item === row));
        event.dataTransfer.dropEffect = 'move';
    });

    document.addEventListener('drop', event => {
        const row = event.target.closest?.('.audioflix-provider-queue-list > li');
        if (!row || dragIndex < 0 || row.parentElement !== dragList) return;
        event.preventDefault();
        const target = rows(row).indexOf(row);
        if (target >= 0) window.EveAudioflix?.queueConnection?.move?.(dragIndex, target);
        clearDrag();
    });

    function clearDrag() {
        dragIndex = -1;
        document.querySelectorAll('.audioflix-provider-queue-list > li').forEach(item => item.classList.remove('is-dragging', 'is-drop-target'));
        dragList = null;
    }

    document.addEventListener('dragend', clearDrag);

    const observer = new MutationObserver(() => enhance());
    const start = () => { observer.observe(document.body, { childList: true, subtree: true }); enhance(); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener('eve:audioflix-queue-changed', () => requestAnimationFrame(enhance));
    Object.assign(ns, { ready: true, enhance });
})();