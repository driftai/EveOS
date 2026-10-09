'use strict';

const path = require('path');
const { launchChromiumOrConnect } = require('./playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const feature = (...parts) => path.join(ROOT, 'js', 'modules', 'features', 'world-book', ...parts);
const expect = (value, message) => { if (!value) throw new Error(message); };

async function main() {
    const launched = await launchChromiumOrConnect({ headless: true });
    const page = await launched.browser.newPage({ viewport: { width: 1024, height: 768 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
        await page.setContent('<!doctype html><html><body><textarea id="notes-area"></textarea><button class="topbar-notes-world-book-btn"></button></body></html>');
        await page.addStyleTag({ path: feature('world-book.css') });
        await page.addStyleTag({ path: feature('world-book.offline.css') });
        await page.addStyleTag({ path: feature('world-book.notes.workspace.css') });
        await page.evaluate(() => {
            let worldRunning = false;
            let notesRunning = false;
            let saved = '';
            let writeRequests = 0;
            const requests = [];
            window.__smoke = {
                requests,
                get worldRunning() { return worldRunning; },
                get notesRunning() { return notesRunning; },
                get saved() { return saved; },
                get writeRequests() { return writeRequests; },
                confirm: true
            };
            window.config = { bridges: { worldBookPort: 8766, notesPort: 8767, localControlPort: 9082 } };
            window.showConfirm = async () => window.__smoke.confirm;
            window.showPrompt = async (_message, value) => value || '';
            window.EveOSLocalControl = {
                baseUrl: () => 'http://127.0.0.1:9082',
                ensure: async () => ({ baseUrl: 'http://127.0.0.1:9082' })
            };
            window.fetch = async (url, options = {}) => {
                requests.push(url);
                const reply = (payload, ok = true, status = 200) => ({ ok, status, json: async () => payload });
                if (url.includes(':8766/api/health')) {
                    if (!worldRunning) throw new TypeError('offline');
                    return reply({ ok: true, service: 'world-book', appVersion: 'smoke', instanceId: 'world-1' });
                }
                if (url.endsWith('/api/world-book/status')) return reply({ ok: true, controllerAvailable: true, installed: true,
                    running: worldRunning, state: worldRunning ? 'running' : 'stopped', url: 'http://127.0.0.1:8766/', message: worldRunning ? 'World Book online.' : 'World Book stopped.' });
                if (url.endsWith('/api/world-book/start')) { worldRunning = true; return window.fetch('http://127.0.0.1:9082/api/world-book/status'); }
                if (url.endsWith('/api/world-book/stop')) { worldRunning = false; return window.fetch('http://127.0.0.1:9082/api/world-book/status'); }
                if (url.includes(':8767/api/health')) {
                    if (!notesRunning) throw new TypeError('offline');
                    return reply({ ok: true, service: 'eveos-notes', appVersion: '1.0', port: 8767 });
                }
                if (url.endsWith('/api/notes-service/status')) return reply({ ok: true, service: 'eveos-notes', controllerAvailable: true,
                    running: notesRunning, state: notesRunning ? 'running' : 'stopped', port: 8767, url: 'http://127.0.0.1:8767', message: notesRunning ? 'EveOS Notes is ready.' : 'EveOS Notes is stopped.' });
                if (url.endsWith('/api/notes-service/start')) { notesRunning = true; return window.fetch('http://127.0.0.1:9082/api/notes-service/status'); }
                if (url.endsWith('/api/notes-service/stop')) { notesRunning = false; return window.fetch('http://127.0.0.1:9082/api/notes-service/status'); }
                if (url.endsWith('/api/notes/workspace')) {
                    if (!notesRunning) throw new Error('Notes workspace used while stopped');
                    return reply({ ok: true, roots: [{ id: 'files', name: 'Notes', kind: 'folder', available: true }, { id: 'spatial', name: 'Spatial Notes', kind: 'folder', available: true }] });
                }
                if (url.endsWith('/api/notes/list')) {
                    const body = JSON.parse(options.body);
                    const spatial = body.rootId === 'spatial';
                    return reply({ ok: true, path: body.path || '', entries: [{ name: spatial ? 'world.md' : 'test.txt', path: spatial ? 'Ideas/world.md' : 'test.txt', kind: 'file', extension: spatial ? '.md' : '.txt', size: 5, revision: 'r1', favorite: false, linkCount: 1, noteRef: spatial ? 'spatial:Ideas/world.md' : 'files:test.txt' }] });
                }
                if (url.endsWith('/api/notes/read')) {
                    const body = JSON.parse(options.body);
                    const spatial = body.rootId === 'spatial';
                    return reply({ ok: true, entry: { name: spatial ? 'world.md' : 'test.txt', path: body.path, kind: 'file', extension: spatial ? '.md' : '.txt', size: 5, revision: 'r1', favorite: false, noteRef: `${body.rootId}:${body.path}` }, content: spatial ? 'world lore' : 'hello' });
                }
                if (url.endsWith('/api/notes/write')) {
                    const body = JSON.parse(options.body); writeRequests += 1; saved = body.content;
                    return reply({ ok: true, entry: { name: body.path.split('/').pop(), path: body.path, extension: body.path.endsWith('.md') ? '.md' : '.txt', size: saved.length, revision: `r${writeRequests + 1}`, noteRef: `${body.rootId}:${body.path}` }, message: 'Saved.' });
                }
                if (url.endsWith('/api/notes/related')) return reply({ ok: true, entries: [{ rootId: 'spatial', name: 'world.md', path: 'Ideas/world.md', kind: 'file', noteRef: 'spatial:Ideas/world.md' }] });
                throw new Error(`Unexpected request: ${url}`);
            };
        });
        for (const file of [
            'world-book.client.js', 'world-book.detach.js', 'world-book.notes.client.js',
            'world-book.notes.lifecycle.js', 'world-book.notes.backup.js', 'world-book.notes.editor-tools.js',
            'world-book.notes.operations.js', 'world-book.notes.workspace.js', 'world-book.overlay.template.js',
            'world-book.overlay.js'
        ]) await page.addScriptTag({ path: feature(file) });

        await page.evaluate(() => window.EveWorldBook.open('world'));
        await page.locator('[data-world-book-server-toggle]').click();
        expect(await page.evaluate(() => window.__smoke.worldRunning), 'Visible Start World Book button did not start World Book');
        await page.locator('[data-world-book-server-toggle]').click();
        expect(!await page.evaluate(() => window.__smoke.worldRunning), 'Visible Stop World Book button did not stop World Book');

        await page.locator('[data-world-book-view="notes"]').click();
        // The two file-backed Notes tabs are user-initiated workspaces. They should start their
        // independent Notes service themselves instead of looking dead until another button is found.
        await page.locator('[data-eve-notes-mode="files"]').click();
        await page.waitForFunction(() => window.__smoke.notesRunning && document.querySelector('[data-eve-notes-list] [data-path="test.txt"]'));
        expect(await page.locator('button[data-eve-notes-mode="files"]').getAttribute('aria-selected') === 'true', 'Notepad files tab did not activate');
        await page.locator('[data-eve-notes-mode="spatial"]').click();
        await page.waitForFunction(() => document.querySelector('[data-eve-notes-list] [data-path="Ideas/world.md"]'));
        expect(await page.locator('button[data-eve-notes-mode="spatial"]').getAttribute('aria-selected') === 'true', 'Spatial Notes tab did not activate');
        await page.locator('[data-eve-notes-mode="files"]').click();
        await page.waitForFunction(() => document.querySelector('[data-eve-notes-list] [data-path="test.txt"]'));
        await page.locator('[data-eve-notes-list] [data-path="test.txt"]').click();
        await page.waitForFunction(() => !document.querySelector('[data-eve-notes-editor]')?.disabled, null, { timeout: 3000 }).catch(async () => {
            const detail = await page.locator('.notes-world-book-overlay').evaluate(node => ({
                status: node.querySelector('[data-eve-notes-status]')?.textContent,
                root: node.querySelector('[data-eve-notes-root]')?.value,
                list: node.querySelector('[data-eve-notes-list]')?.textContent,
                requests: window.__smoke.requests.slice(-8)
            }));
            throw new Error(`Note did not open: ${JSON.stringify(detail)} errors=${JSON.stringify(pageErrors)}`);
        });
        expect(await page.evaluate(() => window.__smoke.notesRunning && !window.__smoke.worldRunning), 'Notes did not run independently with World Book stopped');

        const longDraft = `long note\n${'0123456789abcdef'.repeat(32768)}`;
        await page.locator('[data-eve-notes-editor]').fill(longDraft);
        await page.locator('[data-eve-notes-save]').click();
        await page.waitForFunction(expected => window.__smoke.saved === expected, longDraft, { timeout: 3000 });
        expect(await page.evaluate(() => window.__smoke.writeRequests) === 1, 'Save button sent a duplicate write request');
        expect(await page.locator('[data-eve-notes-status]').textContent().then(text => /Saved|item/.test(text)), 'Successful disk write was not reflected in Notes UI');

        await page.locator('[data-eve-notes-editor]').fill('saved independently');
        await page.locator('[data-eve-notes-editor]').press('Control+s');
        await page.waitForFunction(() => window.__smoke.saved === 'saved independently');
        expect(await page.evaluate(() => window.__smoke.writeRequests) === 2, 'Ctrl+S did not perform exactly one write');
        await page.locator('[data-eve-notes-related]').click();
        await page.locator('[data-eve-notes-related-panel] button').nth(1).click();
        await page.waitForFunction(() => document.querySelector('[data-eve-notes-title]')?.textContent === 'world.md');
        expect(await page.locator('button[data-eve-notes-mode="spatial"]').getAttribute('aria-selected') === 'true', 'Cross-root note link did not switch to Spatial Notes');

        for (const size of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 725, height: 720 }]) {
            await page.setViewportSize(size);
            const geometry = await page.evaluate(() => {
                const overlay = document.querySelector('.notes-world-book-overlay').getBoundingClientRect();
                const browser = document.querySelector('.eve-notes-browser').getBoundingClientRect();
                const save = document.querySelector('[data-eve-notes-save]').getBoundingClientRect();
                return { overlay, browser, save };
            });
            expect(geometry.browser.width > 250 && geometry.browser.height > 180, `Notes browser collapsed at ${size.width}x${size.height}`);
            expect(geometry.save.right <= geometry.overlay.right && geometry.save.bottom <= geometry.overlay.bottom, `Save button clipped at ${size.width}x${size.height}`);
        }

        await page.locator('[data-eve-notes-editor]').fill('unsaved draft');
        await page.evaluate(() => { window.__smoke.confirm = false; });
        await page.locator('[data-world-book-close]').click();
        expect(await page.locator('.notes-world-book-overlay').evaluate(node => node.classList.contains('is-open')), 'Dirty note closed without confirmation');
        expect(pageErrors.length === 0, `Notes browser emitted page errors: ${pageErrors.join(' | ')}`);
        console.log('NOTES_WORLDBOOK_BROWSER_SMOKE_OK');
    } finally {
        await page.close();
        await launched.browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
