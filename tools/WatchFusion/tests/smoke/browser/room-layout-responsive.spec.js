import { test, expect } from '@playwright/test';

async function createEmbeddedRoom(page, roomCode) {
  await page.goto('/?eveos=1');
  await page.click('#headerToggleBtn');
  await page.click('#startPartyBtn');
  await page.fill('#nameInput', 'ResponsiveHost');
  await page.fill('#roomInput', roomCode);
  await page.click('#createBtn');
  await expect(page.locator('#partyPanel')).toBeVisible();
}

test('wide embedded rooms place WatchParty on the right with a vertical splitter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await createEmbeddedRoom(page, 'LAYOUTSIDE1');

  await expect(page.locator('html')).toHaveClass(/watchfusion-party-side/);
  await expect(page.locator('#roomSplitter')).toHaveAttribute('aria-orientation', 'vertical');

  const geometry = await page.evaluate(() => {
    const main = document.querySelector('.maincol').getBoundingClientRect();
    const splitter = document.getElementById('roomSplitter').getBoundingClientRect();
    const panel = document.getElementById('partyPanel').getBoundingClientRect();
    return {
      columns: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.trim().split(/\s+/).length,
      mainRight: main.right,
      splitterLeft: splitter.left,
      splitterRight: splitter.right,
      panelLeft: panel.left,
      panelWidth: panel.width,
      sameTop: Math.abs(main.top - panel.top)
    };
  });

  expect(geometry.columns).toBe(3);
  expect(Math.abs(geometry.mainRight - geometry.splitterLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.splitterRight - geometry.panelLeft)).toBeLessThanOrEqual(1);
  expect(geometry.panelWidth).toBeGreaterThanOrEqual(260);
  expect(geometry.sameTop).toBeLessThanOrEqual(1);
});

test('phone embedded rooms stack WatchParty below media without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createEmbeddedRoom(page, 'LAYOUTPHONE1');

  await expect(page.locator('html')).toHaveClass(/watchfusion-party-bottom/);
  await expect(page.locator('#roomSplitter')).toHaveAttribute('aria-orientation', 'horizontal');

  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const grid = document.querySelector('.grid');
    const main = document.querySelector('.maincol').getBoundingClientRect();
    const splitter = document.getElementById('roomSplitter').getBoundingClientRect();
    const panel = document.getElementById('partyPanel').getBoundingClientRect();
    const form = document.getElementById('chatForm').getBoundingClientRect();
    const chat = document.getElementById('chat').getBoundingClientRect();
    const tabs = getComputedStyle(document.querySelector('.source-tabs')).gridTemplateColumns.trim().split(/\s+/).length;
    const hintDisplay = getComputedStyle(document.querySelector('.host-handoff-hint')).display;
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
      rows: getComputedStyle(grid).gridTemplateRows.trim().split(/\s+/).length,
      sourceTabColumns: tabs,
      mainBottom: main.bottom,
      splitterTop: splitter.top,
      splitterBottom: splitter.bottom,
      panelTop: panel.top,
      panelRight: panel.right,
      panelBottom: panel.bottom,
      formRight: form.right,
      formBottom: form.bottom,
      chatHeight: chat.height,
      hintDisplay,
      rootWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      viewportHeight: innerHeight
    };
  });

  expect(geometry.columns).toBe(1);
  expect(geometry.rows).toBe(3);
  expect(geometry.sourceTabColumns).toBe(3);
  expect(geometry.hintDisplay).toBe('none');
  expect(Math.abs(geometry.mainBottom - geometry.splitterTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.splitterBottom - geometry.panelTop)).toBeLessThanOrEqual(1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.rootWidth + 1);
  expect(geometry.panelRight).toBeLessThanOrEqual(geometry.rootWidth + 1);
  expect(geometry.formRight).toBeLessThanOrEqual(geometry.rootWidth + 1);
  expect(geometry.formBottom).toBeLessThanOrEqual(geometry.panelBottom + 1);
  expect(geometry.chatHeight).toBeGreaterThanOrEqual(64);
  expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
});
