const {
    chromium,
    buildSeedPayload,
    prepareSeededPage,
    clickAndWaitForMap
} = require('./constellation_scope_browser_smoke.shared');

async function main() {
    let browser = null;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 725, height: 520 } });
        await prepareSeededPage(page, buildSeedPayload());

        const topbarBefore = await page.evaluate(() => {
            const strip = document.querySelector('.top-right');
            if (!strip) return null;
            strip.scrollLeft = 0;
            return { left: strip.scrollLeft, max: strip.scrollWidth - strip.clientWidth };
        });
        if (!topbarBefore || topbarBefore.max <= 0) {
            throw new Error(`Top action strip is not horizontally scrollable: ${JSON.stringify(topbarBefore)}`);
        }
        await page.locator('.top-right').hover();
        await page.mouse.wheel(0, 160);
        await page.waitForTimeout(40);
        const topbarAfter = await page.locator('.top-right').evaluate(strip => strip.scrollLeft);
        if (topbarAfter <= topbarBefore.left) {
            throw new Error(`Mouse wheel did not move the top action strip: before=${topbarBefore.left} after=${topbarAfter}`);
        }
        const wheelCapture = await page.locator('.top-right').evaluate(strip => {
            strip.scrollLeft = strip.scrollWidth;
            const event = new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true });
            const dispatchAllowed = strip.dispatchEvent(event);
            return { dispatchAllowed, defaultPrevented: event.defaultPrevented };
        });
        if (wheelCapture.dispatchAllowed || !wheelCapture.defaultPrevented) {
            throw new Error(`Top action strip leaked wheel input to page scrolling: ${JSON.stringify(wheelCapture)}`);
        }

        await clickAndWaitForMap(page, () => (
            page.locator('.topbar-constellation-btn').click()
        ));

        const layout = await page.evaluate(() => {
            function rect(selector) {
                const bounds = document.querySelector(selector)?.getBoundingClientRect();
                return bounds ? {
                    left: bounds.left,
                    right: bounds.right,
                    top: bounds.top,
                    bottom: bounds.bottom,
                    width: bounds.width,
                    height: bounds.height
                } : null;
            }
            return {
                title: rect('.map-shell-top'),
                toolbar: rect('.map-toolbar-stack'),
                primary: rect('.map-toolbar-actions-primary'),
                secondary: rect('.map-toolbar-actions-secondary'),
                search: rect('[data-map-find]'),
                viewportWidth: window.innerWidth
            };
        });

        if (
            !layout.title
            || !layout.toolbar
            || !layout.primary
            || !layout.secondary
            || !layout.search
        ) {
            throw new Error(`Missing Constellation header regions: ${JSON.stringify(layout)}`);
        }
        if (
            layout.title.right + 8 > layout.toolbar.left
            || layout.toolbar.right > layout.viewportWidth + 1
        ) {
            throw new Error(`Constellation header regions overlap: ${JSON.stringify(layout)}`);
        }
        if (layout.primary.bottom > layout.secondary.top + 1) {
            throw new Error(`Constellation toolbar rows overlap: ${JSON.stringify(layout)}`);
        }
        if (layout.search.width < 180) {
            throw new Error(`Constellation search became too narrow: ${JSON.stringify(layout)}`);
        }

        console.log(`CONSTELLATION_HEADER_LAYOUT_BROWSER_SMOKE_OK ${JSON.stringify(layout)}`);
    } finally {
        if (browser) await browser.close();
    }
}

main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
});
