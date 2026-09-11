/**
 * search_monitor_peer_panel_smoke.js
 *
 * Search Monitor owns only itself and explicitly registered/known child surfaces. Unrelated
 * workspaces and dialogs remain outside even when they use role="dialog" for accessibility.
 * Drives the real boot module against a minimal browser fixture.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const BOOT = path.join(ROOT, 'js', 'modules', 'core', 'search-monitor-boot.js');
const fileUrl = (target) => 'file:///' + target.split(path.sep).join('/');

function assert(condition, message) {
    if (!condition) throw new Error('ASSERT FAILED: ' + message);
}

async function main() {
    const fixture = path.join(os.tmpdir(), `sm-peer-${process.pid}.html`);
    fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><body>
        <div id="loadingIndicator" class="visible">
            <div class="status-group">Status</div>
            <p class="monitor-copy">Search Monitor content</p>
            <button class="monitor-action">Run</button>
        </div>
        <div id="watchfusion-overlay" role="dialog"><button class="watchfusion-action">WatchFusion</button></div>
        <div id="notes-world-book-overlay" role="dialog" aria-modal="true">
            <textarea data-world-book-notes>notes</textarea>
        </div>
        <div id="spawned-settings" role="dialog"><button>Settings</button></div>
        <div id="unrelated-dialog" role="dialog"><button>Unrelated popup</button></div>
        <div id="registered-child"><button class="child-btn">Child Action</button><button class="close-btn" data-dismiss>Close</button></div>
        <button id="outside-trigger">Outside Action</button>
        <button id="invoker-btn">Invoke Monitor</button>
        <script>
            window.SearchMonitorBootTrace = {
                ensureTraceRow() {}, ensureTraceDetails() {}, ensureNexusLauncher() {},
                renderTraceDetails() {}, openNexusSearch() {}
            };
        </script>
        <script src="${fileUrl(BOOT)}"></script>
    </body>`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.goto(fileUrl(fixture), { waitUntil: 'load' });
        const result = await page.evaluate(() => {
            const indicator = document.getElementById('loadingIndicator');
            const expand = () => {
                indicator.classList.remove('compact');
                indicator.classList.add('visible');
            };
            const isOpen = () => !indicator.classList.contains('compact');
            const out = { ready: !!window.SearchMonitorBoot };

            expand();
            document.querySelector('#notes-world-book-overlay [data-world-book-notes]').click();
            out.closedByPeerPanel = !isOpen();

            expand();
            document.querySelector('#watchfusion-overlay .watchfusion-action').click();
            out.closedByWatchFusion = !isOpen();

            // Accessibility role alone does not grant ownership.
            expand();
            document.querySelector('#unrelated-dialog button').click();
            out.closedByUnrelatedDialog = !isOpen();

            // A monitor-spawned portal must register ownership before it is exempted.
            const spawned = document.getElementById('spawned-settings');
            const unregisterSpawned = window.SearchMonitorBoot.registerSurface({ element: spawned, owner: 'search-monitor' });
            expand();
            spawned.querySelector('button').click();
            out.survivedSpawnedDialog = isOpen();
            unregisterSpawned();

            expand();
            document.body.click();
            out.closedByPlainOutsideClick = !isOpen();

            expand();
            indicator.querySelector('.monitor-action').click();
            out.survivedOwnControl = isOpen();
            expand();
            indicator.querySelector('.monitor-copy').click();
            out.survivedOwnText = isOpen();
            expand();
            indicator.click();
            out.survivedOwnBackground = isOpen();

            const regChild = document.getElementById('registered-child');
            window.SearchMonitorBoot.registerSurface({ element: regChild, owner: 'search-monitor' });
            expand();
            regChild.querySelector('.child-btn').click();
            out.survivedRegisteredChild = isOpen();
            regChild.querySelector('.close-btn').click();
            out.survivedClosingChild = isOpen();
            window.SearchMonitorBoot.unregisterSurface(regChild);

            let outsideTriggerFired = false;
            document.getElementById('outside-trigger').addEventListener('click', () => { outsideTriggerFired = true; });
            expand();
            document.getElementById('outside-trigger').click();
            out.closedByOutsideTrigger = !isOpen();
            out.outsideActionPrevented = !outsideTriggerFired;

            expand();
            const childDialog = document.createElement('dialog');
            childDialog.id = 'nested-test-dialog';
            childDialog.setAttribute('open', '');
            childDialog.innerHTML = '<button class="cancel">Cancel</button>';
            document.body.appendChild(childDialog);
            window.SearchMonitorBoot.registerSurface({ element: childDialog, owner: 'search-monitor' });
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            out.firstEscapeHandledChild = !childDialog.open;
            out.monitorStayedOpenOnFirstEscape = isOpen();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            out.secondEscapeClosedMonitor = !isOpen();
            return out;
        });

        assert(result.ready, 'the boot module initialised against the fixture');
        assert(result.closedByPeerPanel, 'clicking Notes / World Book closes Search Monitor');
        assert(result.closedByWatchFusion, 'clicking WatchFusion closes Search Monitor');
        assert(result.closedByUnrelatedDialog, 'an unrelated role=dialog surface is outside Search Monitor');
        assert(result.survivedSpawnedDialog, 'explicitly registered monitor child survives');
        assert(result.closedByPlainOutsideClick, 'plain outside click closes Search Monitor');
        assert(result.survivedOwnControl, 'internal controls keep monitor open');
        assert(result.survivedOwnText, 'internal text keeps monitor open');
        assert(result.survivedOwnBackground, 'internal chrome keeps monitor open');
        assert(result.survivedRegisteredChild, 'registered child surface click keeps monitor open');
        assert(result.survivedClosingChild, 'closing child surface keeps monitor open');
        assert(result.closedByOutsideTrigger, 'outside click collapses monitor');
        assert(result.outsideActionPrevented, 'outside dismissal gesture does not activate underlying control');
        assert(result.firstEscapeHandledChild && result.monitorStayedOpenOnFirstEscape, 'first Escape dismisses owned child while monitor stays open');
        assert(result.secondEscapeClosedMonitor, 'second Escape collapses Search Monitor');
        console.log('search monitor explicit overlay ownership contract OK');
        console.log('SEARCH_MONITOR_PEER_PANEL_SMOKE_OK');
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
