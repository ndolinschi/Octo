import assert from "node:assert/strict";
import test from "node:test";
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, clamp, parseTreePref } from "./fileViewPrefs";

const defaults = { open: true, width: TREE_DEFAULT };

test("the documented bounds: 220 default, 200 to 480", () => {
  assert.deepEqual([TREE_DEFAULT, TREE_MIN, TREE_MAX], [220, 200, 480]);
});

test("no stored value reads as the defaults", () => {
  assert.deepEqual(parseTreePref(null), defaults);
  assert.deepEqual(parseTreePref(""), defaults);
});

test("a stored preference is read back", () => {
  assert.deepEqual(parseTreePref('{"open":false,"width":320}'), { open: false, width: 320 });
  assert.deepEqual(parseTreePref(JSON.stringify({ open: true, width: TREE_MIN })), { open: true, width: TREE_MIN });
});

test("widths are clamped to the bounds and rounded", () => {
  assert.equal(parseTreePref('{"width":50}').width, TREE_MIN);
  assert.equal(parseTreePref('{"width":5000}').width, TREE_MAX);
  assert.equal(parseTreePref('{"width":300.6}').width, 301);
  assert.equal(clamp(-1), TREE_MIN);
  assert.equal(clamp(Infinity), TREE_MAX);
});

test("malformed or mistyped stored data falls back field by field", () => {
  for (const raw of ["{", "not json", "[]", "7", "true", '"x"']) assert.deepEqual(parseTreePref(raw), defaults, raw);
  assert.deepEqual(parseTreePref('{"open":"no","width":"wide"}'), defaults);
  assert.deepEqual(parseTreePref('{"open":false}'), { open: false, width: TREE_DEFAULT });
  assert.deepEqual(parseTreePref('{"width":null}'), defaults);
  assert.deepEqual(parseTreePref('{"width":1e999}'), defaults, "infinity in JSON is not a finite width");
});
