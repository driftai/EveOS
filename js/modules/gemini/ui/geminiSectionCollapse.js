/**
 * Gemini Section Collapse — Shared Toggle Logic
 *
 * Wires [data-collapsible-section] elements without observing the entire
 * document subtree. Gemini publishes an explicit workspace-ready event once
 * its late HTML components have been assembled, so we can initialize at known
 * lifecycle boundaries and use delegated clicks for anything added later.
 */
(function () {
    'use strict';

    const STORAGE_PREFIX = 'gemini-collapse-';
    const SECTION_SELECTOR = '[data-collapsible-section]';
    const HEADER_SELECTOR = '[data-collapsible-header]';
    const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, label, .mdl-switch, .mdl-icon-toggle';
    const wiredSections = new WeakSet();

    function getStorageKey(sectionKey) {
        return STORAGE_PREFIX + sectionKey;
    }

    function isCollapsed(sectionKey) {
        try {
            return localStorage.getItem(getStorageKey(sectionKey)) === '1';
        } catch (_) {
            return false;
        }
    }

    function persistState(sectionKey, collapsed) {
        try {
            if (collapsed) {
                localStorage.setItem(getStorageKey(sectionKey), '1');
            } else {
                localStorage.removeItem(getStorageKey(sectionKey));
            }
        } catch (_) { /* storage full or disabled */ }
    }

    function updatePlaceholderConstraints(section, header, collapsed) {
        const placeholder = section.closest(
            '#system-log-display-placeholder, #main-chat-log-placeholder, #agentic-functions-section-placeholder'
        );
        if (placeholder) {
            placeholder.classList.toggle('is-gemini-section-collapsed', collapsed);
            if (collapsed) {
                placeholder.style.minHeight = '0';
                placeholder.style.flex = '0 0 auto';
                placeholder.style.maxHeight = 'max-content';
                placeholder.style.overflow = 'visible';
            } else {
                placeholder.style.minHeight = '';
                placeholder.style.flex = '';
                placeholder.style.maxHeight = '';
                placeholder.style.overflow = '';
            }
        }
        header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    function initSection(section) {
        if (!section || wiredSections.has(section)) return false;

        const sectionKey = section.getAttribute('data-collapsible-section');
        if (!sectionKey) return false;

        const header = section.querySelector(HEADER_SELECTOR);
        if (!header) return false;

        wiredSections.add(section);
        const collapsed = isCollapsed(sectionKey);
        section.classList.toggle('collapsed', collapsed);
        updatePlaceholderConstraints(section, header, collapsed);
        return true;
    }

    function initCollapsibleSections(root) {
        const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
        const sections = [];

        if (scope.nodeType === 1 && scope.matches?.(SECTION_SELECTOR)) {
            sections.push(scope);
        }
        scope.querySelectorAll(SECTION_SELECTOR).forEach(function (section) {
            sections.push(section);
        });

        let newCount = 0;
        sections.forEach(function (section) {
            if (initSection(section)) newCount++;
        });

        if (newCount > 0) {
            console.log('[GeminiCollapse] Initialized ' + newCount + ' new collapsible section(s).');
        }
        return newCount;
    }

    function handleCollapseClick(event) {
        const target = event?.target;
        const header = target?.closest?.(HEADER_SELECTOR);
        if (!header) return;

        const section = header.closest?.(SECTION_SELECTOR);
        if (!section) return;

        if (target.closest?.(INTERACTIVE_SELECTOR)) return;

        // A delegated handler keeps late-added sections functional without a
        // document-wide MutationObserver. Initialize this section lazily if it
        // arrived after the normal Gemini workspace-ready boundary.
        initSection(section);

        const sectionKey = section.getAttribute('data-collapsible-section');
        if (!sectionKey) return;

        const nowCollapsed = section.classList.toggle('collapsed');
        persistState(sectionKey, nowCollapsed);
        updatePlaceholderConstraints(section, header, nowCollapsed);
    }

    function start() {
        initCollapsibleSections(document);
        document.addEventListener('click', handleCollapseClick);

        // The Gemini initialization coordinator emits this after all deferred
        // HTML components have been assembled. One bounded scan here replaces
        // the old body/subtree MutationObserver hot loop.
        window.addEventListener('eve:gemini-workspace-ready', function () {
            initCollapsibleSections(document);
        });
    }

    window.initCollapsibleSections = initCollapsibleSections;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
