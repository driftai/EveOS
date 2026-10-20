'use strict';

const assert = require('node:assert/strict');

async function settle(page) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function verifyResponsiveReload({ page, frame }) {
    const definition = frame.locator('[data-agent-management-form] [name="tloDefinition"]');
    await definition.focus();
    await page.setViewportSize({ width: 820, height: 900 });
    await settle(page);
    const geometry = await frame.evaluate(() => {
        const root = document.documentElement;
        const form = document.querySelector('[data-agent-management-form]');
        const editor = document.querySelector('[data-agent-management-form] [name="tloDefinition"]');
        const save = document.querySelector('[data-agent-management-action="save-definition"]');
        const rect = (node) => {
            const box = node?.getBoundingClientRect();
            return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                width: box.width, height: box.height } : null;
        };
        return { viewport: { width: innerWidth, scrollWidth: root.scrollWidth }, form: rect(form),
            editor: rect(editor), save: rect(save), focused: document.activeElement === editor };
    });
    assert(geometry.form && geometry.editor && geometry.save, 'Narrow Agent Management geometry is incomplete');
    assert(geometry.viewport.scrollWidth <= geometry.viewport.width + 1, 'Agent Management has horizontal page overflow');
    assert(geometry.form.left >= -1 && geometry.form.right <= geometry.viewport.width + 1,
        'Agent Management form is clipped at the narrow viewport');
    assert(geometry.editor.width >= 240 && geometry.editor.height >= 120, 'Markdown definition editor became unusable');
    assert(geometry.save.left >= -1 && geometry.save.right <= geometry.viewport.width + 1,
        'Definition save control is inaccessible');
    assert(geometry.focused, 'Viewport resize stole focus from the active editor');

    await frame.goto(frame.url(), { waitUntil: 'domcontentloaded' });
    await frame.locator('[data-agent-management-status]').waitFor({ state: 'visible' });
    await frame.waitForFunction(() => document.querySelector('[data-agent-management-form]')?.hidden === false);
    assert.equal(await frame.locator('[data-agent-management-form] [name="displayName"]').inputValue(),
        'TLO Browser Smoke', 'Saved agent profile did not survive iframe reload');
    assert.match(await frame.locator('[data-agent-management-form] [name="tloDefinition"]').inputValue(),
        /Edited in browser/, 'Saved TLO definition did not survive iframe reload');
    await page.setViewportSize({ width: 1600, height: 1200 });
    await settle(page);
    return geometry;
}

module.exports = { verifyResponsiveReload };
