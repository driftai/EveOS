// Keep the live Piano DOM and iframe connected across AudioFlix full rerenders.
// The existing Piano bridge, queue and backend remain the only state owners.
window.EveAudioflixPianoRetain = window.EveAudioflixPianoRetain || {};
(function (ns) {
    'use strict';
    if (ns.ready) return;

    function patch(overlay, markup, activeTab) {
        const previous = overlay?.querySelector('.audioflix-panel');
        const content = previous?.querySelector(':scope > .audioflix-content');
        const piano = content?.querySelector(':scope > [data-audioflix-piano]');
        if (!piano) return false; // Piano has never mounted; use normal rendering.

        const template = document.createElement('template');
        template.innerHTML = markup;
        const next = template.content.querySelector('.audioflix-panel');
        const nextContent = next?.querySelector(':scope > .audioflix-content');
        const existingSections = [...previous.children];
        const nextSections = next ? [...next.children] : [];
        const contentIndex = existingSections.indexOf(content);
        if (!next || !nextContent || contentIndex < 0 ||
            nextSections.length !== existingSections.length ||
            nextSections[contentIndex] !== nextContent) {
            throw new Error('Piano retention: unexpected AudioFlix panel structure; refusing to unload the live iframe.');
        }

        // Update the surrounding tabs, settings and modal without replacing the
        // original .audioflix-content or its live Piano iframe.
        for (let i = 0; i < existingSections.length; i++) {
            if (i !== contentIndex) existingSections[i].replaceWith(nextSections[i]);
        }
        for (const name of previous.getAttributeNames()) {
            if (!next.hasAttribute(name)) previous.removeAttribute(name);
        }
        for (const attribute of [...next.attributes]) {
            previous.setAttribute(attribute.name, attribute.value);
        }

        // Piano remains *connected* even while another AudioFlix tab is shown.
        // Moving it to a detached fragment, or removing/reappending the iframe,
        // would discard the iframe's browsing context and restart playback.
        for (const child of [...content.childNodes]) {
            if (child !== piano) child.remove();
        }
        const showingPiano = activeTab === 'piano';
        // display:none (or the hidden attribute) deprioritizes the child frame's
        // WebAudio graph in Chromium. Keep the one live Piano owner rendered just
        // outside the viewport while another Audioflix tab is visible.
        piano.hidden = false;
        piano.style.removeProperty('display');
        piano.classList.toggle('is-background-playback-host', !showingPiano);
        piano.toggleAttribute('inert', !showingPiano);
        piano.setAttribute('aria-hidden', String(!showingPiano));
        if (!showingPiano) content.append(...[...nextContent.childNodes]);
        return true;
    }

    function parkOverlay(overlay) {
        const piano = overlay?.querySelector?.('[data-audioflix-piano]');
        if (!piano?.querySelector?.('[data-piano-frame]') || piano.dataset.running !== 'true') return false;
        overlay.hidden = false;
        overlay.classList.add('is-background-playback-host');
        overlay.inert = true;
        overlay.setAttribute('aria-hidden', 'true');
        return true;
    }

    function restoreOverlay(overlay) {
        if (!overlay) return false;
        overlay.classList.remove('is-background-playback-host');
        overlay.inert = false;
        overlay.removeAttribute('aria-hidden');
        return true;
    }

    Object.assign(ns, { ready: true, patch, parkOverlay, restoreOverlay });
})(window.EveAudioflixPianoRetain);
