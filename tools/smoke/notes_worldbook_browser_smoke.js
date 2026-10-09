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
            let spatialFolderCreated = false;
            let spatialNoteCreated = false;
            const requests = [];
            window.__smoke = {
                requests,
                prompt: '',
                get worldRunning() { return worldRunning; },
                get notesRunning() { return notesRunning; },
                get saved() { return saved; },
                get writeRequests() { return writeRequests; },
                confirm: true
            };
            window.config = { bridges: { worldBookPort: 8766, notesPort: 8767, localControlPort: 9082 } };
            window.showConfirm = async () => window.__smoke.confirm;
            window.showPrompt = async (_message, value) => {
                const answer = window.__smoke.prompt;
                window.__smoke.prompt = '';
                return answer || value || '';
            };
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
                    if (body.rootId === 'spatial') {
                        const inIdeas = body.path === 'Ideas';
                        const entries = inIdeas
                            ? (spatialNoteCreated && body.includeMarkdown ? [{ name: 'world.md', path: 'Ideas/world.md', kind: 'file', extension: '.md', size: 5, revision: 'r1', favorite: false, linkCount: 1, noteRef: 'spatial:Ideas/world.md' }] : [])
                            : (spatialFolderCreated ? [{ name: 'Ideas', path: 'Ideas', kind: 'folder', extension: '', size: null, revision: 'r-folder', favorite: false, linkCount: 0, noteRef: '' }] : []);
                        return reply({ ok: true, path: body.path || '', entries });
                    }
                    return reply({ ok: true, path: body.path || '', entries: [{ name: 'test.txt', path: 'test.txt', kind: 'file', extension: '.txt', size: 5, revision: 'r1', favorite: false, linkCount: 1, noteRef: 'files:test.txt' }] });
                }
                if (url.endsWith('/api/notes/create')) {
                    const body = JSON.parse(options.body);
                    if (body.rootId !== 'spatial') throw new Error('Smoke create expected Spatial Notes');
                    if (body.kind === 'folder' && !body.path && body.name === 'Ideas') spatialFolderCreated = true;
                    else if (body.kind === 'file' && body.path === 'Ideas' && body.name === 'world.md') spatialNoteCreated = true;
                    else throw new Error(`Unexpected create: ${JSON.stringify(body)}`);
                    return reply({ ok: true, message: body.kind === 'folder' ? 'Folder created.' : 'Note created.' });
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
        await page.locator('button[data-eve-notes-mode="files"]').click();
        await page.waitForFunction(() => window.__smoke.notesRunning && document.querySelector('[data-eve-notes-list] [data-path="test.txt"]'));
        expect(await page.locator('button[data-eve-notes-mode="files"]').getAttribute('aria-selected') === 'true', 'Notepad files tab did not activate');

        await page.locator('button[data-eve-notes-mode="spatial"]').click();
        expect(await page.locator('button[data-eve-notes-mode="spatial"]').getAttribute('aria-selected') === 'true', 'Spatial Notes tab did not activate');
        await page.evaluate(() => { window.__smoke.prompt = 'Ideas'; });
        await page.locator('[data-eve-notes-create="folder"]').click();
        await page.waitForFunction(() => document.querySelector('[data-eve-notes-list] [data-path="Ideas"][data-kind="folder"]'));
        await page.locator('[data-eve-notes-list] [data-path="Ideas"]').click();
        await page.waitForFunction(() => window.EveWorldBook.notesWorkspace.context().path === 'Ideas');
        await page.evaluate(() => { window.__smoke.prompt = 'world.md'; });
        await page.locator('[data-eve-notes-create="file"]').click();
        await page.waitForFunction(() => document.querySelector('[data-eve-notes-list] [data-path="Ideas/world.md"]'));
        expect(await page.locator('[data-eve-notes-markdown]').isChecked(), 'Creating a Markdown note left it hidden behind the Markdown filter');
        await page.locator('[data-eve-notes-list] [data-path="Ideas/world.md"]').click();
        await page.waitForFunction(() => document.querySelector('[data-eve-notes-title]')?.textContent === 'world.md');
        expect(await page.evaluate(() => window.EveWorldBook.notesWorkspace.context().path) === 'Ideas', 'Opening a nested Spatial Note lost its folder path');
        await page.locator('button[data-eve-notes-mode="spatial"]').click();
        await page.waitForFunction(() => window.EveWorldBook.notesWorkspace.context().path === 'Ideas');
        expect(await page.locator('[data-eve-notes-title]').textContent() === 'world.md', 'Re-entering active Spatial Notes kicked the user out of the open note');
        expect(await page.locator('[data-eve-notes-path]').textContent() === 'Ideas', 'Re-entering active Spatial Notes reset the folder to root');

        // Parent navigation must use the same guarded folder lifecycle as entering a folder. This
        // covers the live failure where a saved nested note left the Up arrow stuck in that folder.
        await page.locator('[data-eve-notes-editor]').fill('saved nested note');
        await page.locator('[data-eve-notes-save]').click();
        await page.waitForFunction(() => window.__smoke.saved === 'saved nested note');
        await page.locator('[data-eve-notes-up]').click();
        await page.waitForFunction(() => window.EveWorldBook.notesWorkspace.context().path === '');
        expect(await page.locator('[data-eve-notes-title]').textContent() === 'Select a note', 'Parent navigation did not clear the nested editor');
        expect(await page.locator('[data-eve-notes-list] [data-path="Ideas"]').count() === 1, 'Parent navigation did not restore the Spatial Notes root');

        await page.locator('button[data-eve-notes-mode="files"]').click();
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
        expect(await page.evaluate(() => window.__smoke.writeRequests) === 2, 'Save button sent a duplicate write request');
        expect(await page.locator('[data-eve-notes-status]').textContent().then(text => /Saved|item/.test(text)), 'Successful disk write was not reflected in Notes UI');

        await page.locator('[data-eve-notes-editor]').fill('saved independently');
        await page.locator('[data-eve-notes-editor]').press('Control+s');
        await page.waitForFunction(() => window.__smoke.saved === 'saved independently');
        expect(await page.evaluate(() => window.__smoke.writeRequests) === 3, 'Ctrl+S did not perform exactly one write');
        await page.locator('[data-eve-notes-related]').click();
        await page.locator('[data-eve-notes-related-panel] button').nth(1).click();
        await page.waitForFunction(() => document.querySelector('[data-eve-notes-title]')?.textContent === 'world.md');
        expect(await page.locator('button[data-eve-notes-mode="spatial"]').getAttribute('aria-selected') === 'true', 'Cross-root note link did not switch to Spatial Notes');
        expect(await page.evaluate(() => window.EveWorldBook.notesWorkspace.context().path) === 'Ideas', 'Cross-root note link lost its containing Spatial Notes folder');

        for (const size of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 725, height: 720 }]) {
            await page.setViewportSize(size);
            const geometry = await page.evaluate(() => {
                const overlay = document.querySelector('.notes-world-book-overlay').getBoundingClientRect();
                const browser = document.querySelector('.eve-notes-browser').getBoundingClientRect();
                const save = document.querySelector('[data-eve-notes-save]').getBoundingClientRect();
                const search = document.querySelector('[data-eve-notes-search-all]').getBoundingClientRect();
                const firstEntry = document.querySelector('[data-eve-notes-list] .eve-notes-entry')?.getBoundingClientRect() || null;
                return { overlay, browser, save, search, firstEntry };
            });
            expect(geometry.browser.width > 250 && geometry.browser.height > 180, `Notes browser collapsed at ${size.width}x${size.height}`);
            expect(geometry.save.right <= geometry.overlay.right && geometry.save.bottom <= geometry.overlay.bottom, `Save button clipped at ${size.width}x${size.height}`);
            expect(!geometry.firstEntry || geometry.search.bottom <= geometry.firstEntry.top + 0.5, `Search all overlaps note rows at ${size.width}x${size.height}`);
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