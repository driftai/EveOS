const { chromium, firefox, webkit } = require('playwright');
const { instrumentBrowser } = require('./renderer_watchdog');

function getCdpEndpoint() {
    return process.env.PW_CDP_ENDPOINT
        || process.env.PLAYWRIGHT_CDP_ENDPOINT
        || process.env.PW_BROWSER_WS_ENDPOINT
        || process.env.PLAYWRIGHT_BROWSER_WS_ENDPOINT
        || '';
}

function getBrowserChannel() {
    return process.env.PW_BROWSER_CHANNEL
        || process.env.PLAYWRIGHT_BROWSER_CHANNEL
        || '';
}

function getBrowserName() {
    const name = String(
        process.env.PW_BROWSER_NAME
        || process.env.PLAYWRIGHT_BROWSER_NAME
        || 'chromium'
    ).trim().toLowerCase();
    if (name === 'firefox' || name === 'webkit') return name;
    return 'chromium';
}

function getExecutablePath() {
    return process.env.PW_EXECUTABLE_PATH
        || process.env.PLAYWRIGHT_EXECUTABLE_PATH
        || '';
}

function getBrowserType(browserName) {
    if (browserName === 'firefox') return firefox;
    if (browserName === 'webkit') return webkit;
    return chromium;
}

function addBlockedLaunchHint(error) {
    if (!error || !error.message) return error;
    if (!/spawn EPERM|EACCES/i.test(error.message)) return error;
    if (getCdpEndpoint()) return error;

    var hint = 'Browser launch was blocked by this shell. Start a browser with remote debugging and set PW_CDP_ENDPOINT or PLAYWRIGHT_CDP_ENDPOINT, or run from a shell that can launch Playwright browsers.';
    error.message += '\n\n' + hint;
    if (error.stack && !error.stack.includes(hint)) {
        error.stack += '\n\n' + hint;
    }
    return error;
}

function watchedBrowser(browser) {
    return instrumentBrowser(browser);
}

async function launchChromiumOrConnect(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const headless = opts.headless !== false;
    const browserName = String(opts.browserName || getBrowserName()).trim().toLowerCase();
    const browserType = getBrowserType(browserName);
    const launchOptions = Object.assign({}, opts.launchOptions || {}, { headless: headless });
    const cdpEndpoint = String(opts.cdpEndpoint || getCdpEndpoint()).trim();
    const channel = String(opts.channel || getBrowserChannel()).trim();
    const executablePath = String(opts.executablePath || getExecutablePath()).trim();

    if (cdpEndpoint) {
        return {
            browser: watchedBrowser(await chromium.connectOverCDP(cdpEndpoint)),
            mode: 'connectOverCDP',
            endpoint: cdpEndpoint
        };
    }

    if (channel) {
        launchOptions.channel = channel;
    }
    if (executablePath) {
        launchOptions.executablePath = executablePath;
    }

    try {
        return {
            browser: watchedBrowser(await browserType.launch(launchOptions)),
            mode: 'launch',
            endpoint: ''
        };
    } catch (error) {
        if (cdpEndpoint) {
            return {
                browser: watchedBrowser(await chromium.connectOverCDP(cdpEndpoint)),
                mode: 'connectOverCDP',
                endpoint: cdpEndpoint
            };
        }
        throw addBlockedLaunchHint(error);
    }
}

async function waitForEveCoreHydrated(page, timeoutMs) {
    const timeout = Math.max(1000, Number(timeoutMs || 0) || 180000);
    await page.waitForFunction(() => {
        const summary = window.__eveLastCoreDataLoadSummary;
        return !!summary && Number(summary.completedAt || 0) > 0;
    }, undefined, { timeout });
    await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
}

module.exports = {
    chromium,
    firefox,
    webkit,
    launchChromiumOrConnect,
    waitForEveCoreHydrated,
    getCdpEndpoint,
    getBrowserChannel,
    getBrowserName,
    getExecutablePath
};
