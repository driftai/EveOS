const path = require('path');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FILE_URL = 'file:///' + path.join(REPO_ROOT, 'EveOS.html').replace(/\\/g, '/');

function buildSeedPayload() {
  return {
    links: [
      { id: 'main-alpha-1', title: 'Main Alpha One', url: 'https://example.com/main-alpha-1', workspace: 'main', category: 'Alpha', done: false },
      { id: 'child-alpha-1', title: 'Child Alpha One', url: 'https://example.com/child-alpha-1', workspace: 'child', category: 'Alpha', done: false }
    ],
    config: {
      activeWorkspace: 'main',
      viewMode: 'grid',
      showInactiveTabs: true,
      workspaces: [
        {
          id: 'main',
          name: 'Main',
          icon: 'folder',
          subTabs: [
            { id: 'child', name: 'Child', icon: 'folder', hiddenInParent: false, subTabs: [] }
          ]
        }
      ],
      categoryOrder: ['Alpha'],
      categoryOrderByWorkspace: {
        main: ['Alpha'],
        child: ['Alpha']
      },
      hideStats: [],
      smartCardWeights: [],
      customOrderEnabled: [],
      customOrder: {},
      customOrderSort: {},
      trueValueEnabled: []
    }
  };
}

async function waitForApp(page) {
  await page.waitForFunction(() => (
    typeof window.renderDashboard === 'function'
    && typeof window.showCategoryContextMenu === 'function'
    && typeof window.ctxCatToggleSmartBadge === 'function'
    && typeof window.ctxCatToggleCustomOrder === 'function'
    && typeof window.ctxCatCycleSortOrder === 'function'
    && typeof window.ctxCatToggleTrueValue === 'function'
    && !!window.EveCustomOrder
    && !!window.EveTrueValue
    && !!window.__EVE_DEFERRED_SCRIPT_STATE?.completedAt
  ), undefined, { timeout: 120000 });
  await page.waitForTimeout(250);
}

async function seedState(page, seed) {
  await page.evaluate((payload) => {
    config = JSON.parse(JSON.stringify(payload.config));
    links = JSON.parse(JSON.stringify(payload.links));
    window.config = config;
    window.links = links;
    if (window.eveState) {
      window.eveState.config = config;
      window.eveState.links = links;
    }

    // CARD_LAUNCH_FIXTURE_INDEX_INVALIDATION_V5: synthetic links bypass EveOS mutations.
    // The startup datapack index may still contain the Start card after replacing links.
    const fixtureIndex = window.EveOS?.DatapackIndex || window.EveOS?.SearchAdvanced?.Index || null;
    if (fixtureIndex && typeof fixtureIndex.markDirty !== 'function') {
      throw new Error('Card Launch test index cannot invalidate its stale fixture');
    }
    fixtureIndex?.markDirty?.('card-launch-test-fixture-replaced');
    window.EveDashboardPrefetch?.clearCache?.();
    window.showToast = function () {};
    if (typeof window.renderDashboard !== 'function') {
      throw new Error('Card Launch test dashboard renderer is missing');
    }
    window.renderDashboard();
  }, seed);
  // renderDashboard coalesces work into the next animation frame. Observe the
  // real category DOM before asserting context menu or invoking the Launch action.
  await page.waitForFunction(() => (
    !!document.querySelector('.category-card[data-card-category="Alpha"][data-card-workspace="main"]')
  ), undefined, { timeout: 15000 });
}

async function runSmoke(page) {
  const snapshot = await page.evaluate(() => {
    window.ctxWsId = 'child';
    window.ctxCatName = 'Alpha';
    window.ctxCatToggleSmartBadge();
    window.ctxCatToggleCustomOrder();
    window.ctxCatCycleSortOrder();
    window.ctxCatToggleTrueValue();

    const fakeEvent = {
      preventDefault: function () {},
      stopPropagation: function () {},
      clientX: 20,
      clientY: 20
    };
    window.showCategoryContextMenu(fakeEvent, 'Alpha', 'child');
    const menu = document.getElementById('cat-context-menu');
    const items = Array.from(menu?.querySelectorAll('.ctx-item') || []).map((node) => String(node.textContent || '').trim());
    const settingsItem = menu?.querySelector('.ctx-item[data-ws]');
    const renameItem = menu?.querySelector('.ctx-item[data-ws][data-cat]');

    return {
      smartCardWeights: Array.isArray(window.config?.smartCardWeights) ? window.config.smartCardWeights.slice() : [],
      customOrderMainEnabled: !!window.EveCustomOrder.isEnabled('main', 'Alpha'),
      customOrderChildEnabled: !!window.EveCustomOrder.isEnabled('child', 'Alpha'),
      customOrderMainSort: window.EveCustomOrder.getSortMode('main', 'Alpha'),
      customOrderChildSort: window.EveCustomOrder.getSortMode('child', 'Alpha'),
      trueValueMainEnabled: !!window.EveTrueValue.isEnabled('main', 'Alpha'),
      trueValueChildEnabled: !!window.EveTrueValue.isEnabled('child', 'Alpha'),
      menuItems: items,
      settingsWs: String(settingsItem?.dataset.ws || ''),
      renameWs: String(renameItem?.dataset.ws || '')
    };
  });

  if (JSON.stringify(snapshot.smartCardWeights) !== JSON.stringify(['child::Alpha'])) {
    throw new Error('Smart badge toggle wrote to the wrong workspace scope: ' + JSON.stringify(snapshot));
  }
  if (snapshot.customOrderMainEnabled || !snapshot.customOrderChildEnabled) {
    throw new Error('Custom order toggle used the wrong workspace scope: ' + JSON.stringify(snapshot));
  }
  if (snapshot.customOrderMainSort !== 'none' || snapshot.customOrderChildSort !== 'asc') {
    throw new Error('Custom order sort cycle used the wrong workspace scope: ' + JSON.stringify(snapshot));
  }
  if (snapshot.trueValueMainEnabled || !snapshot.trueValueChildEnabled) {
    throw new Error('True value toggle used the wrong workspace scope: ' + JSON.stringify(snapshot));
  }
  if (snapshot.settingsWs !== 'child' || snapshot.renameWs !== 'child') {
    throw new Error('Category context menu did not retain child workspace routing: ' + JSON.stringify(snapshot));
  }
  if (!snapshot.menuItems.some((item) => item.includes('Custom Numbering') && item.includes('✓'))) {
    throw new Error('Context menu label did not reflect child custom-order state: ' + JSON.stringify(snapshot));
  }
  if (!snapshot.menuItems.some((item) => item.includes('True Value Sort') && item.includes('✓'))) {
    throw new Error('Context menu label did not reflect child true-value state: ' + JSON.stringify(snapshot));
  }

  return snapshot;
}


// Real pointer-click regression for the card Launch action; mocks only tab ownership
// for exact multi-URL assertions. The final case uses an actual Chromium popup.
async function runCardLaunchSmoke(page) {
  const cardSelector = '.category-card[data-card-category="Alpha"][data-card-workspace="main"]';
  const selector = cardSelector + ' .launch-btn';
  // The preceding context-menu assertions leave the menu open. Clear it before
  // exercising the production pointer action and re-render this small seeded scope.
  await page.evaluate(() => {
    if (typeof window.closeAllMenus === 'function') window.closeAllMenus();
    const search = document.getElementById('search');
    if (search) search.value = '';
    config.activeWorkspace = 'main';
    if (typeof window.renderDashboard === 'function') window.renderDashboard();
  });
  const card = page.locator(cardSelector);
  try {
    await card.waitFor({ state: 'visible', timeout: 15000 });
    // Deferred shells intentionally omit header actions until hydrated.
    // Hover triggers EveOS' real on-demand hydration, not an injected test button.
    await card.hover();
    await page.locator(selector).waitFor({ state: 'visible', timeout: 15000 });
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      activeWorkspace: config.activeWorkspace,
      viewMode: config.viewMode,
      cards: Array.from(document.querySelectorAll('.category-card')).slice(0, 12).map(node => ({
        workspace: node.dataset.cardWorkspace || '',
        category: node.dataset.cardCategory || '',
        deferred: node.dataset.cardDeferred || '',
        hydrationError: node.dataset.cardHydrationError || '',
        launchButtons: node.querySelectorAll('.launch-btn').length
      })),
      gridExists: !!document.getElementById('dashboard-grid'),
      liveLinks: typeof getLiveLinks === 'function' ? getLiveLinks().length : -1
    }));
    throw new Error('Card Launch fixture not hydrated: ' + JSON.stringify(snapshot)
      + ' | ' + String(error && error.message ? error.message : error));
  }
  await page.evaluate(() => {
    window.__cardLaunchSmokeOriginal = {
      activeWorkspace: config.activeWorkspace,
      links: window.eveState?.links,
      open: window.open
    };
    const entries = [
      { id: 'l1', workspace: 'main', category: 'Alpha', url: 'https://example.com/one', done: false },
      { id: 'l2', workspace: 'main', category: 'Alpha', url: 'https://example.com/two', done: false },
      { id: 'l3', workspace: 'main', category: 'Alpha', url: 'https://example.com/three', done: false },
      { id: 'l4', workspace: 'main', category: 'Alpha', url: 'https://example.com/one', done: false },
      { id: 'l5', workspace: 'main', category: 'Alpha', url: 'javascript:alert(1)', done: false },
      { id: 'l6', workspace: 'main', category: 'Alpha', url: '', done: false },
      { id: 'l7', workspace: 'main', category: 'Alpha', url: 'https://example.com/done', done: true },
      { id: 'l8', workspace: 'child', category: 'Alpha', url: 'https://example.com/other', done: false },
      { id: 'l9', workspace: 'main', category: 'Other', url: 'https://example.com/wrong', done: false }
    ];
    if (window.eveState) window.eveState.links = entries;
    window.links = entries;
    config.activeWorkspace = 'child'; // Rendered main card must retain its own scope.
    window.__cardLaunchOpened = [];
    window.__cardLaunchTabs = [];
    window.open = function () {
      const tab = {
        opener: window,
        location: { replace(url) { window.__cardLaunchOpened.push(url); } },
        close() {}
      };
      window.__cardLaunchTabs.push(tab);
      return tab;
    };
  });
  const button = page.locator(selector);
  if (await button.getAttribute('data-ws') !== 'main') throw new Error('Launch button lost its card workspace scope');
  await button.click();
  const result = await page.evaluate(() => ({
    urls: window.__cardLaunchOpened.slice(),
    safe: window.__cardLaunchTabs.every(tab => tab.opener === null)
  }));
  const expected = ['https://example.com/one', 'https://example.com/two', 'https://example.com/three'];
  if (JSON.stringify(result.urls) !== JSON.stringify(expected) || !result.safe) {
    throw new Error('Scoped Launch was not exact/deduplicated/opener-safe: ' + JSON.stringify(result));
  }

  await page.evaluate(() => { window.open = () => null; });
  await button.click();
  const blocked = await page.locator('#eve-card-launch-blocked-links a').evaluateAll(nodes =>
    nodes.map(node => ({ href: node.href, rel: node.rel, target: node.target })));
  if (JSON.stringify(blocked.map(x => x.href)) !== JSON.stringify(expected)
      || blocked.some(x => !x.rel.includes('noopener') || x.target !== '_blank')) {
    throw new Error('Blocked popup fallback omitted safe, clickable URLs: ' + JSON.stringify(blocked));
  }

  await page.evaluate(() => {
    window.open = window.__cardLaunchSmokeOriginal.open;
    const one = [{ id: 'one', workspace: 'main', category: 'Alpha', url: 'https://example.com/one', done: false }];
    if (window.eveState) window.eveState.links = one;
    window.links = one;
    document.getElementById('eve-card-launch-blocked-links')?.remove();
  });
  await page.context().route('https://example.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Card Launch fixture</title>'
  }));
  const popupPromise = page.waitForEvent('popup', { timeout: 12000 });
  await button.click();
  const popup = await popupPromise;
  await popup.waitForURL('https://example.com/one', { timeout: 12000 });
  await popup.close();
  await page.evaluate(() => {
    const previous = window.__cardLaunchSmokeOriginal;
    config.activeWorkspace = previous.activeWorkspace;
    if (window.eveState) window.eveState.links = previous.links;
    window.links = previous.links;
    window.open = previous.open;
    delete window.__cardLaunchSmokeOriginal;
    delete window.__cardLaunchOpened;
    delete window.__cardLaunchTabs;
  });
  return { scopedUrls: expected.length, blockedFallback: blocked.length, realPopup: true };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error && error.message ? error.message : error));
  });

  try {
    await page.goto(FILE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitForApp(page);
    await seedState(page, buildSeedPayload());
    const smoke = await runSmoke(page);
    const launchSmoke = await runCardLaunchSmoke(page);
    smoke.cardLaunch = launchSmoke;
    console.log(JSON.stringify({
      ok: true,
      smoke,
      consoleErrors,
      pageErrors
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: String(error && error.stack ? error.stack : error),
      consoleErrors,
      pageErrors
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
