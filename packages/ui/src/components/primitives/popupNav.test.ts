import assert from "node:assert/strict";
import test from "node:test";
import { createPointerGate, popupTarget } from "./popupNav";

const ids = ["a", "b", "c"];

test("popupTarget: arrows wrap at both ends", () => {
  assert.equal(popupTarget("ArrowDown", ids, "a"), "b");
  assert.equal(popupTarget("ArrowDown", ids, "c"), "a");
  assert.equal(popupTarget("ArrowUp", ids, "a"), "c");
  assert.equal(popupTarget("ArrowUp", ids, "c"), "b");
});

test("popupTarget: no active row starts from the matching end", () => {
  assert.equal(popupTarget("ArrowDown", ids, null), "a");
  assert.equal(popupTarget("ArrowUp", ids, null), "c");
  assert.equal(popupTarget("ArrowDown", ids, "gone"), "a");
});

test("popupTarget: Home and End jump; other keys and empty lists give null", () => {
  assert.equal(popupTarget("Home", ids, "c"), "a");
  assert.equal(popupTarget("End", ids, "a"), "c");
  assert.equal(popupTarget("Enter", ids, "a"), null);
  assert.equal(popupTarget("ArrowDown", [], null), null);
});

test("popupTarget: a single row stays active", () => {
  assert.equal(popupTarget("ArrowDown", ["x"], "x"), "x");
  assert.equal(popupTarget("ArrowUp", ["x"], "x"), "x");
});

test("createPointerGate: the first event and a repeat at the same spot do not count", () => {
  const gate = createPointerGate();
  assert.equal(gate({ clientX: 5, clientY: 5 }), false);
  assert.equal(gate({ clientX: 5, clientY: 5 }), false);
  assert.equal(gate({ clientX: 6, clientY: 5 }), true);
  assert.equal(gate({ clientX: 6, clientY: 5 }), false);
});
