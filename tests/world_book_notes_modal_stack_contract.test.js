'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const dialogs = fs.readFileSync(path.join(ROOT, 'js/modules/ui/notifications/dialogs.js'), 'utf8');
const workspace = fs.readFileSync(path.join(ROOT, 'js/modules/features/world-book/world-book.notes.workspace.js'), 'utf8');
const manifest = fs.readFileSync(path.join(ROOT, 'js/config/manifest/scripts.parts/01-ui.js'), 'utf8');

test('Notes prompts stack above the high-z Notes and World Books overlay', () => {
    assert.match(dialogs, /\.notes-world-book-overlay\.is-open/);
    assert.match(dialogs, /getModalStackZIndex\(\).*\+ 2/);
    assert.match(dialogs, /overlay\.style\.display = 'flex'/);
    assert.match(dialogs, /requestAnimationFrame\(\(\) => \{[\s\S]*input\.focus\(\)/);
});

test('Spatial new note and folder actions use the visible shared prompt', () => {
    assert.match(workspace, /const requested = await promptValue\(label\)/);
    assert.match(workspace, /ns\.notesClient\.create\(currentRoot, currentPath, name, kind\)/);
    assert.match(workspace, /data-eve-notes-create/);
});

test('dialog cache key changes with the Notes stacking fix', () => {
    assert.match(manifest, /notifications\/dialogs\.js\?v=cdbac54c46d5/);
});
