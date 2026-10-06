/**
 * Search Monitor Scroll Preservation
 *
 * The expanded Search Monitor / Gemini workspace scroll areas could snap back to the top when a
 * periodic update or a new Gemini message re-rendered a subtree or reset scrollTop. The fix is
 * source-agnostic: remember where the USER scrolled, and if something later resets a container to
 * the top without user input, snap it back.
 *
 * It is GENERIC — it tracks any scrollable element the user actually scrolls inside the monitor
 * (the outer `.gemini-monitor-shell`, the control column, chat/system logs, past chats, etc.)
 * rather than a hard-coded list, so it can't miss a container. It only restores when a tracked
 * element is reset to ~top while we hold a meaningful saved position, so it never fights a
 * deliberate scroll-to-top and never interferes with the chat's auto-scroll-to-bottom.
 */
(function () {
    'use strict';
    if (window.__eveMonitorScrollPreserveReady) return;
    window.__eveMonitorScrollPreserveReady = true;

    const ROOT_ID = 'loadingIndicator';
    const MIN_MEANINGFUL = 4;          // ignore tiny scrolls
    const SCROLLABLE_SLACK = 8;        // px of overflow needed to count as scrollable
    const USER_INPUT_WINDOW_MS = 700;

    const sigTop = Object.create(null);   // signature -> last user scrollTop (survives re-render)
    const tracked = new Set();            // live element refs the user has scrolled
    let lastUserInputAt = 0;
    let restoring = false;
    let observer = null;
    let restoreFrame = 0;
    let restoreTimer = 0;

    function root() { return document.getElementById(ROOT_ID); }

    function isScrollable(el) {
        return el instanceof Element && (el.scrollHeight - el.clientHeight) > SCROLLABLE_SLACK;
    }

    // Stable-ish key so a saved position can survive the container being re-rendered/replaced.
    function signature(el) {
        if (el.id) return '#' + el.id;
        let cls = '';
        if (typeof el.className === 'string' && el.className.trim()) {
            cls = '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
        }
        return el.tagName.toLowerCase() + cls;
    }

    function restoreAll() {
        const host = root();
        if (!host) return;
        restoring = true;
        try {
            tracked.forEach(function (el) {
                if (!host.contains(el)) { tracked.delete(el); return; }
                const want = sigTop[signature(el)];
                if (want > MIN_MEANINGFUL && el.scrollTop <= 1 && (el.scrollHeight - el.clientHeight) > SCROLLABLE_SLACK) {
                    el.scrollTop = want;
                }
            });
        } finally {
            restoring = false;
        }
    }

    // Mutation delivery can be extremely dense while Gemini mounts/streams UI. Never enqueue one
    // RAF + timeout pair per mutation batch: coalesce to at most one of each, and do no mutation
    // work at all until the user has actually scrolled something worth preserving.
    function scheduleRestore() {
        if (!tracked.size) return;
        if (!restoreFrame) {
            restoreFrame = window.requestAnimationFrame(function () {
                restoreFrame = 0;
                restoreAll();
            });
        }
        if (!restoreTimer) {
            restoreTimer = window.setTimeout(function () {
                restoreTimer = 0;
                restoreAll();
            }, 120);
        }
    }

    // The old implementation observed the entire Search Monitor subtree as soon as EveOS booted.
    // During Gemini workspace mount that observer could receive a mutation storm and saturate the
    // renderer even though there was no saved scroll position yet. Arm it lazily only after real
    // user scrolling has created state that may need restoration.
    function ensureObserver() {
        if (observer || !tracked.size) return;
        const host = root();
        if (!host) return;
        observer = new MutationObserver(scheduleRestore);
        observer.observe(host, { childList: true, subtree: true });
    }

    // Track genuine user intent so a programmatic reset isn't mistaken for a user scroll.
    ['wheel', 'touchmove', 'keydown', 'pointerdown', 'mousedown'].forEach(function (type) {
        document.addEventListener(type, function () { lastUserInputAt = Date.now(); },
            { capture: true, passive: true });
    });

    // scroll doesn't bubble -> capture phase.
    document.addEventListener('scroll', function (event) {
        const el = event.target;
        if (restoring || !(el instanceof Element)) return;
        const host = root();
        if (!host || !host.contains(el) || !isScrollable(el)) return;
        const key = signature(el);
        if ((Date.now() - lastUserInputAt) < USER_INPUT_WINDOW_MS) {
            // User put it here (including a deliberate scroll to top) -> remember it.
            sigTop[key] = el.scrollTop;
            tracked.add(el);
            ensureObserver();
        } else if (el.scrollTop <= 1 && sigTop[key] > MIN_MEANINGFUL) {
            // A non-user reset to the top -> put it back where the user was.
            restoring = true;
            el.scrollTop = sigTop[key];
            restoring = false;
        }
    }, true);

    // Explicit lifecycle edges are cheap and cover the common mount/refresh cases. scheduleRestore
    // is a no-op until the user has a saved position, so these listeners stay passive during boot.
    ['eve:gemini-workspace-ready', 'eve:search-monitor-refresh'].forEach(function (type) {
        window.addEventListener(type, scheduleRestore);
    });

    window.EveMonitorScrollPreserve = {
        restoreAll: restoreAll,
        scheduleRestore: scheduleRestore,
        _sigTop: sigTop,
        _tracked: tracked
    };
})();
