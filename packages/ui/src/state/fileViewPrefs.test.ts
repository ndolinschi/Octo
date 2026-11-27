import assert from "node:assert/strict";
import test from "node:test";
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, clamp, columnWidth, parseTreePref } from "./fileViewPrefs";

const defaults = { open: false, width: TREE_DEFAULT };

test("the documented bounds: the default follows the view (0), 200 to 480 once dragged", () => {
  assert.deepEqual([TREE_DEFAULT, TREE_MIN, TREE_MAX], [0, 200, 480]);
});

test("no stored value reads as the defaults", () => {
  assert.deepEqual(parseTreePref(null), defaults);
  assert.deepEqual(parseTreePref(""), defaults);
});

test("a stored preference is read back", () => {
  assert.deepEqual(parseTreePref('{"open":false,"width":320}'), { open: false, width: 320 });
  assert.deepEqual(parseTreePref(JSON.stringify({ open: true, width: TREE_MIN })), { open: true, width: TREE_MIN });
  assert.deepEqual(parseTreePref('{"open":false,"width":0}'), defaults, "the default is stored as 0");
});

test("the old fixed default (220), which every untouched project stored, reads as the default", () => {
  assert.deepEqual(parseTreePref('{"open":false,"width":220}'), defaults);
  assert.equal(parseTreePref('{"width":236}').width, 236, "a dragged width is kept");
});

test("widths are clamped to the bounds and rounded", () => {
  assert.equal(parseTreePref('{"width":50}').width, TREE_MIN);
  assert.equal(parseTreePref('{"width":5000}').width, TREE_MAX);
  assert.equal(parseTreePref('{"width":300.6}').width, 301);
  assert.equal(clamp(-1), TREE_MIN);
  assert.equal(clamp(Infinity), TREE_MAX);
  assert.equal(columnWidth(TREE_DEFAULT), TREE_DEFAULT);
  assert.equal(columnWidth(120), TREE_MIN);
});

test("malformed or mistyped stored data falls back field by field", () => {
  for (const raw of ["{", "not json", "[]", "7", "true", '"x"']) assert.deepEqual(parseTreePref(raw), defaults, raw);
  assert.deepEqual(parseTreePref('{"open":"no","width":"wide"}'), defaults);
  assert.deepEqual(parseTreePref('{"open":false}'), { open: false, width: TREE_DEFAULT });
  assert.deepEqual(parseTreePref('{"width":null}'), defaults);
  assert.deepEqual(parseTreePref('{"width":1e999}'), defaults, "infinity in JSON is not a finite width");
});
