/**
 * search_monitor_peer_panel_smoke.js
 *
 * Clicking from the Search Monitor onto the Notes / World Book panel must close the monitor.
 * Clicking inside the expanded Search Monitor itself must keep it open unless the click hits the
 * dedicated status/detail-collapse affordance.
 *
 * The monitor deliberately ignores clicks on dialogs it spawned itself (clear-chat, settings,
 * confirms) so those do not close it out from under the user. That exemption matched
 * `[role="dialog"]` — and the Notes / World Book overlay carries role="dialog" for accessibility.
 * So switching to that panel counted as "still inside the monitor's world" and the monitor stayed
 * open on top of the panel the user had just moved to.
 *
 * These directions are pinned because the fix is only correct if it stays narrow:
 *   - the peer panel DOES close the monitor;
 *   - a genuine monitor-spawned dialog still does NOT;
 *   - internal controls and blank monitor chrome do NOT collapse the expanded monitor.
 *
 * Drives the real module against a minimal fixture (no EveOS boot, no servers), so a failure points
 * at the click-routing rule rather than at page startup.
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
        <div id="notes-world-book-overlay" role="dialog" aria-modal="true">
            <textarea data-world-book-notes>notes</textarea>
        </div>
        <div id="spawned-settings" role="dialog"><button>Settings</button></div>
        <div id="registered-child"><button class="child-btn">Child Action</button><button class="close-btn" data-dismiss>Close</button></div>
        <button id="outside-trigger">Outside Action</button>
        <button id="invoker-btn">Invoke Monitor</button>
        <script>
            // bind() calls into the trace module; stub only what it touches.
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

            // Switching to the Notes / World Book panel must close the monitor.
            expand();
            document.querySelector('#notes-world-book-overlay [data-world-book-notes]').click();
            out.closedByPeerPanel = !isOpen();

            // The panel's own chrome counts too, not just its inner controls.
            expand();
            document.getElementById('notes-world-book-overlay').click();
            out.closedByPeerPanelChrome = !isOpen();

            // A dialog the monitor spawned must still NOT close it.
            expand();
            document.querySelector('#spawned-settings button').click();
            out.survivedSpawnedDialog = isOpen();

            // A plain outside click still closes it (the original behaviour).
            expand();
            document.body.click();
            out.closedByPlainOutsideClick = !isOpen();

            // Controls, text, and blank chrome inside an expanded monitor all keep it open.
            expand();
            indicator.querySelector('.monitor-action').click();
            out.survivedOwnControl = isOpen();

            expand();
            indicator.querySelector('.monitor-copy').click();
            out.survivedOwnText = isOpen();

            expand();
            indicator.click();
            out.survivedOwnBackground = isOpen();

            // Generic registered surface ownership:
            const regChild = document.getElementById('registered-child');
            window.SearchMonitorBoot.registerSurface({ element: regChild, owner: 'search-monitor' });
            expand();
            regChild.querySelector('.child-btn').click();
            out.survivedRegisteredChild = isOpen();

            // Closing the child surface leaves monitor open
            regChild.querySelector('.close-btn').click();
            out.survivedClosingChild = isOpen();

            // Unregister child surface after test so it does not linger in active surfaces
            window.SearchMonitorBoot.unregisterSurface(regChild);

            // Gesture interception: clicking an outside trigger closes monitor without firing outside handler
            let outsideTriggerFired = false;
            document.getElementById('outside-trigger').addEventListener('click', () => {
                outsideTriggerFired = true;
            });
            expand();
            document.getElementById('outside-trigger').click();
            out.closedByOutsideTrigger = !isOpen();
            out.outsideActionPrevented = !outsideTriggerFired;

            // Nested Escape: first Escape closes child dialog, second closes monitor
            expand();
            const childDialog = document.createElement('dialog');
            childDialog.id = 'nested-test-dialog';
            childDialog.setAttribute('open', '');
            childDialog.innerHTML = '<button class="cancel">Cancel</button>';
            document.body.appendChild(childDialog);
            window.SearchMonitorBoot.registerSurface({ element: childDialog, owner: 'search-monitor' });

            const escEvent1 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            document.dispatchEvent(escEvent1);
            out.firstEscapeHandledChild = !childDialog.open;
            out.monitorStayedOpenOnFirstEscape = isOpen();

            const escEvent2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            document.dispatchEvent(escEvent2);
            out.secondEscapeClosedMonitor = !isOpen();

            return out;
        });

        assert(result.ready, 'the boot module initialised against the fixture');
        assert(result.closedByPeerPanel, 'clicking peer panel closes Search Monitor');
        assert(result.closedByPeerPanelChrome, 'clicking peer panel chrome closes Search Monitor');
        assert(result.survivedSpawnedDialog, 'spawned dialog survives');
        assert(result.closedByPlainOutsideClick, 'plain outside click closes Search Monitor');
        assert(result.survivedOwnControl, 'internal controls keep monitor open');
        assert(result.survivedOwnText, 'internal text keeps monitor open');
        assert(result.survivedOwnBackground, 'internal chrome keeps monitor open');
        assert(result.survivedRegisteredChild, 'registered child surface click keeps monitor open');
        assert(result.survivedClosingChild, 'closing child surface keeps monitor open');
        assert(result.closedByOutsideTrigger, 'outside click collapses monitor');
        assert(result.outsideActionPrevented, 'outside dismissal gesture is intercepted and does not fire underlying control');
        assert(result.firstEscapeHandledChild && result.monitorStayedOpenOnFirstEscape, 'first Escape dismisses child surface while monitor stays open');
        assert(result.secondEscapeClosedMonitor, 'second Escape collapses Search Monitor');

        console.log('search monitor generic overlay contract OK');
        console.log('SEARCH_MONITOR_PEER_PANEL_SMOKE_OK');
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
