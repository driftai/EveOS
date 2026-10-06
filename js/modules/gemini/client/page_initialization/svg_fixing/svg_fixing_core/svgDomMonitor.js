/**
 * svgDomMonitor.js
 * Handles DOM monitoring and MutationObservers for SVG fixes.
 */

window.SvgFixingCore = window.SvgFixingCore || {};

(function () {
    const STATE_KEY = '__EVE_GEMINI_SVG_MONITOR_STATE';

    function getState() {
        if (!window[STATE_KEY]) {
            window[STATE_KEY] = {
                root: null,
                observer: null,
                sweepTimer: null,
                pendingFixTimer: null
            };
        }
        return window[STATE_KEY];
    }

    function getGeminiRoot() {
        return document.getElementById('gemini-provider-runtime-host')
            || document.getElementById('gemini-ui-root')
            || null;
    }

    function classNameText(node) {
        const value = node?.className;
        if (typeof value === 'string') return value;
        if (value && typeof value.baseVal === 'string') return value.baseVal;
        return '';
    }

    function nodeNeedsSvgFix(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;

        if (node.tagName === 'SVG') {
            const viewBox = node.getAttribute('viewBox');
            if (viewBox && viewBox.includes('%')) return true;
        }

        if (node.querySelector?.('svg[viewBox*="%"]')) return true;

        const classes = classNameText(node);
        if (/mdl-(?:js-)?progress|progress/i.test(classes)) {
            return !!node.querySelector?.('svg:not([viewBox]), svg[viewBox*="%"]');
        }

        return false;
    }

    function stopMonitor(state) {
        state.observer?.disconnect?.();
        state.observer = null;
        if (state.sweepTimer) {
            clearInterval(state.sweepTimer);
            state.sweepTimer = null;
        }
        if (state.pendingFixTimer) {
            clearTimeout(state.pendingFixTimer);
            state.pendingFixTimer = null;
        }
        state.root = null;
    }

    window.SvgFixingCore.stopSvgViewBoxMonitor = function () {
        stopMonitor(getState());
    };

    window.SvgFixingCore.setupSvgViewBoxMonitor = function () {
        console.log('Setting up scoped SVG viewBox monitoring (Modularized)...');

        if (!window.SvgFixingCore.fixSvgViewBoxIssues) {
            console.error('SvgFixingCore.fixSvgViewBoxIssues not found! Monitoring cannot start.');
            return false;
        }

        const root = getGeminiRoot();
        if (!root) {
            console.warn('Gemini SVG monitor deferred because the provider workspace does not exist yet.');
            return false;
        }

        const state = getState();
        if (state.root === root && state.observer) {
            return true;
        }
        stopMonitor(state);
        state.root = root;

        const runFixes = () => {
            if (!state.root?.isConnected) {
                stopMonitor(state);
                return;
            }
            window.SvgFixingCore.fixSvgViewBoxIssues(state.root);
        };

        const scheduleFix = (delay = 16) => {
            // A workspace bootstrap can add hundreds of nodes in a few milliseconds.
            // Keep exactly one pending sweep instead of queuing one full scan per mutation batch.
            if (state.pendingFixTimer) return;
            state.pendingFixTimer = setTimeout(() => {
                state.pendingFixTimer = null;
                runFixes();
            }, delay);
        };

        state.observer = new MutationObserver((mutations) => {
            let needsFixing = false;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (nodeNeedsSvgFix(node)) {
                            needsFixing = true;
                            break;
                        }
                    }
                } else if (mutation.type === 'attributes') {
                    const element = mutation.target;
                    if (mutation.attributeName === 'viewBox' && element?.tagName === 'SVG') {
                        const viewBox = element.getAttribute('viewBox');
                        needsFixing = !!(viewBox && viewBox.includes('%'));
                    } else if (mutation.attributeName === 'class' || mutation.attributeName === 'data-upgraded') {
                        needsFixing = nodeNeedsSvgFix(element);
                    }
                }

                if (needsFixing) break;
            }

            if (needsFixing) scheduleFix();
        });

        state.observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['viewBox', 'class', 'data-upgraded']
        });

        state.sweepTimer = setInterval(() => {
            if (!state.root?.isConnected) {
                stopMonitor(state);
                return;
            }
            if (state.root.querySelector('svg[viewBox*="%"], .mdl-progress svg:not([viewBox]), .mdl-js-progress svg:not([viewBox])')) {
                scheduleFix(0);
            }
        }, 10000);

        // Do not schedule an activation sweep here. PageInitializationCore performs
        // one bounded scoped repair before arming this observer.
        console.log('Scoped SVG viewBox monitor activated for Gemini workspace');
        return true;
    };
})();

console.log('svgDomMonitor.js loaded.');
