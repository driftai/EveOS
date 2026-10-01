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
            const requests = [];
            window.__smoke = { requests, get worldRunning() { return worldRunning; }, get notesRunning() { return notesRunning; }, get saved() { return saved; }, confirm: true };
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
                if (url.endsWith('/api/notes/workspace')) return reply({ ok: true, roots: [{ id: 'files', name: 'Notes', kind: 'folder', available: true }, { id: 'spatial', name: 'Spatial Notes', kind: 'folder', available: true }] });
                if (url.endsWith('/api/notes/list')) return reply({ ok: true, path: '', entries: [{ name: 'test.txt', path: 'test.txt', kind: 'file', extension: '.txt', size: 5, revision: 'r1', favorite: false, linkCount: 0, noteRef: 'files:test.txt' }] });
                if (url.endsWith('/api/notes/read')) return reply({ ok: true, entry: { name: 'test.txt', path: 'test.txt', kind: 'file', extension: '.txt', size: 5, revision: 'r1', favorite: false, noteRef: 'files:test.txt' }, content: 'hello' });
                if (url.endsWith('/api/notes/write')) { saved = JSON.parse(options.body).content; return reply({ ok: true, entry: { name: 'test.txt', path: 'test.txt', extension: '.txt', size: saved.length, revision: 'r2', noteRef: 'files:test.txt' }, message: 'Saved.' }); }
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
        await page.locator('[data-eve-notes-mode="files"]').click();
        await page.waitForTimeout(250);
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
        await page.locator('[data-eve-notes-editor]').fill('saved independently');
        await page.locator('[data-eve-notes-editor]').press('Control+s');
        await page.waitForFunction(() => window.__smoke.saved === 'saved independently');

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
        console.log('NOTES_WORLDBOOK_BROWSER_SMOKE_OK');
    } finally {
        await page.close();
        await launched.browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
