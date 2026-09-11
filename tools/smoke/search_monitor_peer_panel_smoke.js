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
            const expand = () => indicator.classList.remove('compact');
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
            return out;
        });

        assert(result.ready, 'the boot module initialised against the fixture');
        assert(result.closedByPeerPanel,
            'clicking the Notes / World Book panel closes the Search Monitor — the reported peer-panel bug');
        assert(result.closedByPeerPanelChrome,
            'clicking the panel chrome (not just its fields) also closes the monitor');
        assert(result.survivedSpawnedDialog,
            'a monitor-spawned dialog still does NOT close the monitor, so the fix stayed narrow');
        assert(result.closedByPlainOutsideClick, 'an ordinary outside click still closes the monitor');
        assert(result.survivedOwnControl, 'using a control inside the monitor does not collapse it');
        assert(result.survivedOwnText, 'clicking non-interactive content inside the monitor does not collapse it');
        assert(result.survivedOwnBackground, 'clicking blank monitor chrome does not collapse the expanded monitor');

        console.log('search monitor peer panel OK — outside peers close it, internal clicks remain stable,'
            + ' and monitor-spawned dialogs stay exempt');
        console.log('SEARCH_MONITOR_PEER_PANEL_SMOKE_OK');
    } finally {
        await browser.close();
        fs.rmSync(fixture, { force: true });
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
