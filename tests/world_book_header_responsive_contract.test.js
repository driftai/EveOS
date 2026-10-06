'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'js/modules/features/world-book/world-book.responsive.css'), 'utf8');

test('World Book header prevents title and action overlap below desktop width', () => {
    assert.match(css, /@media \(max-width: 980px\)[\s\S]*grid-template-columns: minmax\(150px, 0\.72fr\) minmax\(0, 1\.28fr\)/);
    assert.match(css, /\.notes-world-book-identity strong \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;/);
    assert.match(css, /\.notes-world-book-actions \{[\s\S]*flex-wrap: wrap;/);
});

test('World Book header becomes a single-column control stack in the narrow panel', () => {
    assert.match(css, /@media \(max-width: 840px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /\.notes-world-book-actions \{[\s\S]*grid-row: 2;[\s\S]*width: 100%;/);
    assert.match(css, /\.notes-world-book-tabs \{[\s\S]*grid-row: 3;/);
    assert.match(css, /\.notes-world-book-detach-state \{[\s\S]*display: none;/);
});

test('Phone layout keeps only compact essential header controls', () => {
    assert.match(css, /@media \(max-width: 620px\)[\s\S]*\[data-world-book-server-toggle\],[\s\S]*\[data-world-book-reader-controls\][\s\S]*display: none;/);
    assert.match(css, /@media \(max-width: 420px\)[\s\S]*\.notes-world-book-tabs \{[\s\S]*width: 100%;/);
});
