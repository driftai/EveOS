'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'js/modules/features/world-book/world-book.responsive.css'), 'utf8');

function mediaSection(maxWidth, nextMaxWidth) {
    const startToken = `@media (max-width: ${maxWidth}px)`;
    const start = css.indexOf(startToken);
    assert.notEqual(start, -1, `Expected ${startToken}`);
    const end = nextMaxWidth
        ? css.indexOf(`@media (max-width: ${nextMaxWidth}px)`, start + startToken.length)
        : css.length;
    return css.slice(start, end === -1 ? css.length : end);
}

test('World Book header prevents title and action overlap below desktop width', () => {
    assert.match(css, /@media \(max-width: 980px\)[\s\S]*grid-template-columns: minmax\(150px, 0\.72fr\) minmax\(0, 1\.28fr\)/);
    assert.match(css, /\.notes-world-book-identity strong \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;/);
    assert.match(css, /\.notes-world-book-actions \{[\s\S]*flex-wrap: wrap;[\s\S]*justify-content: center;/);
});

test('World Book header centers usable controls in the narrow panel', () => {
    assert.match(css, /@media \(max-width: 840px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /\.notes-world-book-actions \{[\s\S]*grid-row: 2;[\s\S]*width: 100%;[\s\S]*justify-content: center;/);
    assert.match(css, /\.notes-world-book-tabs \{[\s\S]*grid-row: 3;[\s\S]*justify-self: center;[\s\S]*justify-content: center;/);
    assert.match(css, /\.notes-world-book-actions button,[\s\S]*\.notes-world-book-tabs button \{[\s\S]*min-height: 35px;[\s\S]*padding: 7px 11px;/);
});

test('Phone layout keeps lifecycle and Reader controls visible instead of shrinking them away', () => {
    const phone = mediaSection(620, 420);
    assert.match(phone, /\[data-world-book-server-toggle\],\s*\[data-world-book-reader-controls\] \{\s*display: inline-flex;/);
    assert.match(phone, /\.notes-world-book-actions button,\s*\.notes-world-book-tabs button \{[\s\S]*?min-height: 35px;/);
    assert.doesNotMatch(phone, /\[data-world-book-server-toggle\],\s*\[data-world-book-reader-controls\] \{\s*display: none;/);
});

test('Scratchpad, Notepad files, and Spatial Notes sub-tabs cannot leak into World Book or Portal views', () => {
    assert.match(css, /\.notes-world-book-overlay:not\(\[data-view="notes"\]\) \.eve-notes-tabs/);
    assert.match(css, /\.notes-world-book-overlay:not\(\[data-view="notes"\]\) \.eve-notes-scratchpad/);
    assert.match(css, /\.notes-world-book-overlay:not\(\[data-view="notes"\]\) \.eve-notes-workspace/);
    assert.match(css, /display: none !important;/);
});
