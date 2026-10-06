// mdlLayoutWrapperUILoader.js
// Loads the MDL layout wrapper HTML component into the Gemini provider workspace.

function geminiMdlUpgradeTargets(root) {
    if (!root) return [];
    const targets = [];
    if (root.matches?.('[class*="mdl-js-"]')) targets.push(root);
    root.querySelectorAll?.('[class*="mdl-js-"]').forEach((node) => targets.push(node));
    return targets;
}

async function loadMdlLayoutWrapper() {
    console.log('[MDL Layout Wrapper] Loading MDL layout wrapper component...');

    try {
        const htmlContent = `
<!-- MDL Layout Wrapper Component -->
<div class="mdl-layout mdl-js-layout mdl-layout--fixed-header">
    <!-- Page Header Placeholder -->
    <div id="page-header-placeholder"></div>
    <main class="mdl-layout__content">
        <!-- Main Content Area Placeholder -->
        <div id="main-content-area-placeholder"></div>
    </main>
</div>
`;

        const container = document.getElementById('gemini-provider-runtime-host')
            || document.getElementById('gemini-ui-root')
            || document.body;
        container.insertAdjacentHTML('beforeend', htmlContent);
        const wrapper = container.lastElementChild;

        const loadingState = document.getElementById('app-loading-state');
        if (loadingState) {
            loadingState.remove();
        }

        console.log('[MDL Layout Wrapper] HTML content inserted into Gemini workspace');

        // Only upgrade MDL components inside the wrapper just inserted. A document.body
        // upgrade would scan unrelated EveOS sections and defeats provider isolation.
        if (typeof componentHandler !== 'undefined') {
            const targets = geminiMdlUpgradeTargets(wrapper);
            if (targets.length && typeof componentHandler.upgradeElements === 'function') {
                componentHandler.upgradeElements(targets);
            } else if (typeof componentHandler.upgradeElement === 'function') {
                targets.forEach((node) => componentHandler.upgradeElement(node));
            }
            console.log(`[MDL Layout Wrapper] Upgraded ${targets.length} Gemini MDL component(s)`);
        } else {
            console.warn('[MDL Layout Wrapper] componentHandler not available, skipping upgrade');
        }

        console.log('[MDL Layout Wrapper] MDL layout wrapper component loaded successfully');
        return Promise.resolve();

    } catch (error) {
        console.error('[MDL Layout Wrapper] Error loading MDL layout wrapper component:', error);
        return Promise.reject(error);
    }
}

window.loadMdlLayoutWrapper = loadMdlLayoutWrapper;
