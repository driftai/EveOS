window.EveAudioflixQueueReorder = window.EveAudioflixQueueReorder || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixQueueReorder;
    if (ns.ready) return;
    let dragIndex = -1;

    function rows() {
        return [...document.querySelectorAll('.audioflix-provider-queue-list > li')];
    }

    function enhance() {
        const list = document.querySelector('.audioflix-provider-queue-list');
        if (!list) return;
        const all = [...list.children];
        all.forEach((row, index) => {
            if (!(row instanceof HTMLElement)) return;
            row.dataset.queueIndex = String(index);
            row.draggable = true;
            const main = row.querySelector('[data-url-player-action="queue-jump"]');
            if (main) main.classList.add('audioflix-queue-entry-main');
            if (!row.querySelector('.audioflix-queue-drag-handle')) {
                const grip = document.createElement('span');
                grip.className = 'audioflix-queue-drag-handle';
                grip.textContent = '⋮⋮';
                grip.title = 'Drag to reorder';
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
        const index = rows().indexOf(row);
        const delta = Number(button.dataset.queueMove) || 0;
        if (index >= 0 && delta) window.EveAudioflix?.queueConnection?.move?.(index, index + delta);
    }, true);

    document.addEventListener('dragstart', event => {
        const row = event.target.closest?.('.audioflix-provider-queue-list > li');
        if (!row) return;
        if (!event.target.closest?.('.audioflix-queue-drag-handle')) {
            event.preventDefault();
            return;
        }
        dragIndex = rows().indexOf(row);
        row.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', String(dragIndex)); } catch {}
    });

    document.addEventListener('dragover', event => {
        const row = event.target.closest?.('.audioflix-provider-queue-list > li');
        if (!row || dragIndex < 0) return;
        event.preventDefault();
        rows().forEach(item => item.classList.toggle('is-drop-target', item === row));
        event.dataTransfer.dropEffect = 'move';
    });

    document.addEventListener('drop', event => {
        const row = event.target.closest?.('.audioflix-provider-queue-list > li');
        if (!row || dragIndex < 0) return;
        event.preventDefault();
        const target = rows().indexOf(row);
        if (target >= 0) window.EveAudioflix?.queueConnection?.move?.(dragIndex, target);
        dragIndex = -1;
        rows().forEach(item => item.classList.remove('is-dragging', 'is-drop-target'));
    });

    document.addEventListener('dragend', () => {
        dragIndex = -1;
        rows().forEach(item => item.classList.remove('is-dragging', 'is-drop-target'));
    });

    const observer = new MutationObserver(() => enhance());
    const start = () => { observer.observe(document.body, { childList: true, subtree: true }); enhance(); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener('eve:audioflix-queue-changed', () => requestAnimationFrame(enhance));
    Object.assign(ns, { ready: true, enhance });
})();