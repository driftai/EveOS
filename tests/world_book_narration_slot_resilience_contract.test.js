'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(
    path.join(ROOT, 'js/modules/features/world-book/world-book.narration.gemini.js'),
    'utf8'
);

test('World Book narrator avoids redundant output transcription work', () => {
    assert.match(source, /inlineTranscriptionMode: false/);
    assert.match(source, /outputTranscriptionEnabled: false/);
});

test('World Book narrator ignores empty PCM sentinels and falls back quickly when audio never starts', () => {
    assert.match(source, /const FIRST_AUDIO_TIMEOUT_MS = 18000/);
    assert.match(source, /const MIN_AUDIO_CHUNK_BYTES = 64/);
    assert.match(source, /if \(bytes\.byteLength >= MIN_AUDIO_CHUNK_BYTES\)/);
    assert.match(source, /Gemini narration did not start audio in time/);
});

test('World Book narrator releases its Live slot after idle and immediately after failed turns', () => {
    assert.match(source, /const IDLE_CLOSE_MS = 6000/);
    assert.match(source, /function scheduleIdleClose\(\)/);
    assert.match(source, /if \(!pendingTurn\) close\('Narration session released after idle\.'\)/);
    assert.match(source, /window\.setTimeout\(\(\) => close\('Gemini narration turn failed\.'\), 0\)/);
    assert.match(source, /scheduleIdleClose\(\);/);
});
