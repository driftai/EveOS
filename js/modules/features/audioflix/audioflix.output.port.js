// One logical output gain shared by every Audioflix transport. Provider players cannot all be
// wired into the same Web Audio graph (cross-origin iframes forbid that), so this module is the
// common control port: adapters ask it for their effective level before touching their own API.
window.EveAudioflixOutputPort = window.EveAudioflixOutputPort || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixOutputPort;
    if (ns.ready) return;
    let liveLevel = null;

    const clamp = (value, fallback = 1) => {
        const numeric = Number(value);
        return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : fallback));
    };

    function level() {
        return liveLevel ?? clamp(window.EveAudioflixState?.ensure?.()?.outputVolume, 1);
    }

    function effective(itemVolume) {
        return clamp(itemVolume, 1) * level();
    }

    function setVolume(value, options = {}) {
        const next = clamp(value, 1);
        liveLevel = next;
        if (options.persist !== false) {
            window.EveAudioflixState?.update?.({ outputVolume: next }, 'audioflix-output-volume');
            liveLevel = null;
        }
        window.dispatchEvent?.(new CustomEvent('eve:audioflix-output-volume', {
            detail: { volume: next }
        }));
        return next;
    }

    function handleInput(target) {
        if (!target?.matches?.('.audioflix-output-port-volume')) return false;
        const next = setVolume(target.value, { persist: false });
        target.style.setProperty('--vol', `${next * 100}%`);
        const label = target.parentElement?.querySelector('.audioflix-output-port-label');
        if (label) label.textContent = `${Math.round(next * 100)}%`;
        return true;
    }

    function handleChange(target) {
        if (!target?.matches?.('.audioflix-output-port-volume')) return false;
        setVolume(target.value);
        return true;
    }

    function render(snapshot) {
        const value = clamp(snapshot?.outputVolume, 1);
        return `<article class="audioflix-status-card audioflix-output-port-card is-on">
            <span>EveOS Song Output Port</span>
            <strong>All Audioflix providers · ${Math.round(value * 100)}%</strong>
            <p>Master gain after each track level. Direct files, YouTube, Spotify, SoundCloud, Vimeo, Instagram, layered sounds, and native playback follow this control.</p>
            <label class="audioflix-output-port-control">
                <span>Output volume</span>
                <input class="audioflix-output-port-volume" type="range" min="0" max="1" step="0.01" value="${value}" style="--vol:${value * 100}%" aria-label="EveOS song output volume">
                <b class="audioflix-output-port-label">${Math.round(value * 100)}%</b>
            </label>
        </article>`;
    }

    Object.assign(ns, { ready: true, level, effective, setVolume, handleInput, handleChange, render });
})();
