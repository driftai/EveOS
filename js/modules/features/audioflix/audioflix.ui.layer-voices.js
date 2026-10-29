window.EveAudioflixLayerVoices = window.EveAudioflixLayerVoices || {};

(function (ns) {
    'use strict';
    if (ns.ready) return;

    const snapshots = new Map();
    const pendingItems = new Set();
    let pendingFrame = 0;
    let pendingTimer = 0;
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
    const formatTime = (seconds) => {
        const safe = Math.max(0, Number(seconds) || 0);
        return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
    };
    const formatRemaining = (seconds) => {
        const totalMilliseconds = Math.ceil(Math.max(0, Number(seconds) || 0) * 1000);
        const wholeSeconds = Math.floor(totalMilliseconds / 1000);
        const milliseconds = totalMilliseconds % 1000;
        return `-${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`
            + `.${String(milliseconds).padStart(3, '0')}`;
    };

    function voiceModel(voice, index) {
        const progress = Math.max(0, Math.min(1, Number(voice.progress) || 0));
        const elapsed = formatTime(voice.currentTime);
        const duration = voice.duration > 0 ? formatTime(voice.duration) : '--:--';
        const pending = voice.pending === true;
        const remaining = pending ? 'starting' : voice.duration > 0 ? formatRemaining(voice.remaining) : 'live';
        const number = index + 1;
        return { key: String(voice.id || voice.sequence || `layer-${index}`), elapsed, remaining, pending,
            label: `Layer ${number}: ${elapsed} of ${duration}, ${remaining} remaining`, number,
            progress: `${(progress * 100).toFixed(2)}%` };
    }

    function renderFallback(host, active) {
        host.innerHTML = active.map((voice, index) => {
            const model = voiceModel(voice, index);
            return `<div class="audioflix-layer-voice" data-state="${model.pending ? 'starting' : 'playing'}" title="${escapeHtml(model.label)}" style="--af-layer-progress:${model.progress}"><span>Layer ${model.number}</span><em>${model.remaining}</em></div>`;
        }).join('');
    }

    function createRow(host, key) {
        const row = host.ownerDocument.createElement('div');
        row.className = 'audioflix-layer-voice'; row.dataset.afLayerVoice = key;
        row.innerHTML = '<span></span><em></em>';
        return row;
    }

    function renderHost(host, voices) {
        if (!host) return;
        const active = Array.isArray(voices) ? voices : [];
        host.dataset.count = String(active.length);
        host.style.setProperty('--af-layer-height', `${Math.max(18, 24 - Math.floor(Math.max(0, active.length - 1) * .6))}px`);
        if (!host.ownerDocument?.createElement || !host.children) return renderFallback(host, active);
        const existing = new Map([...host.children].map(row => [String(row.dataset.afLayerVoice || ''), row]));
        active.forEach((voice, index) => {
            const model = voiceModel(voice, index);
            const row = existing.get(model.key) || createRow(host, model.key);
            existing.delete(model.key); row.title = model.label;
            row.dataset.state = model.pending ? 'starting' : 'playing';
            row.style.setProperty('--af-layer-progress', model.progress);
            const values = [`Layer ${model.number}`, model.remaining];
            [...row.children].forEach((node, childIndex) => { if (node.textContent !== values[childIndex]) node.textContent = values[childIndex]; });
            if (host.children[index] !== row) host.insertBefore(row, host.children[index] || null);
        });
        existing.forEach(row => row.remove());
    }

    function render(root = document) {
        root?.querySelectorAll?.('[data-af-layer-voices]')?.forEach(host => {
            renderHost(host, snapshots.get(String(host.dataset.afLayerVoices || '')) || []);
        });
    }

    function flushPending() {
        if (pendingFrame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(pendingFrame);
        if (pendingTimer && typeof window.clearTimeout === 'function') window.clearTimeout(pendingTimer);
        pendingFrame = 0;
        pendingTimer = 0;
        const ids = [...pendingItems]; pendingItems.clear();
        ids.forEach(id => document.querySelectorAll?.('[data-af-layer-voices]')?.forEach(host => {
            if (String(host.dataset.afLayerVoices || '') === id) renderHost(host, snapshots.get(id) || []);
        }));
    }

    function schedule(id) {
        pendingItems.add(id);
        if (pendingFrame || pendingTimer) return;
        if (typeof window.requestAnimationFrame === 'function') pendingFrame = window.requestAnimationFrame(flushPending);
        if (typeof window.setTimeout === 'function') pendingTimer = window.setTimeout(flushPending, 64);
        else if (!pendingFrame) flushPending();
    }

    window.addEventListener('eve:audioflix-layer-voices', event => {
        const id = String(event.detail?.itemId || '');
        const voices = Array.isArray(event.detail?.voices) ? event.detail.voices : [];
        if (voices.length) snapshots.set(id, voices);
        else snapshots.delete(id);
        schedule(id);
    });

    Object.assign(ns, { ready: true, render, snapshots });
})(window.EveAudioflixLayerVoices);
