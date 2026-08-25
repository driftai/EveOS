import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../web/sheet_progress.js", import.meta.url), "utf8");
const esm = `${source.replace("export function buildSheetEventRanges", "function buildSheetEventRanges")}\nexport { buildSheetEventRanges };`;
const { buildSheetEventRanges } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(esm)}`);

const kinds = (text, profile = "expressive") => buildSheetEventRanges(text, profile).map(event => event.kind);
const spans = (text, profile = "expressive") => buildSheetEventRanges(text, profile).map(event => text.slice(event.start, event.end));

assert.deepEqual(kinds("  a b  "), ["note", "pause", "note"]);
assert.deepEqual(spans("  a b  "), ["a", " ", "b"]);
assert.deepEqual(kinds("[ab]"), ["chord"]);
assert.deepEqual(spans("[ab]"), ["[ab]"]);
assert.deepEqual(kinds("[a b]"), ["fast", "fast"]);
assert.deepEqual(spans("[a b]"), ["a", "b"]);
assert.deepEqual(kinds("a--| |b"), ["note", "pause", "pause", "pause", "note"]);
assert.deepEqual(spans("a--| |b"), ["a", "--", "|", " ", "b"]);
assert.deepEqual(kinds("a  b [cd] {ef} --", "grid"), ["note", "note", "chord", "fast", "fast", "pause"]);
assert.deepEqual(kinds("a b [cd] --", "letter_grid"), ["note", "note", "chord", "pause"]);

const ranges = buildSheetEventRanges("abc [de]");
assert.deepEqual(ranges.map(event => event.index), [1, 2, 3, 4, 5]);
assert.equal(typeof ranges[3].start, "number");
assert.equal(typeof ranges[3].end, "number");

console.log("sheet_progress parser-alignment smoke: PASS");
