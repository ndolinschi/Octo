import assert from "node:assert/strict";
import test from "node:test";
import { createPointerGate, popupListKey, popupMove, popupTarget } from "./popupNav";

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

const ev = (key: string, mod = false) => ({ key, ctrlKey: mod, metaKey: false });

test("popupListKey: in a typing list plain Home/End stay with the caret, Ctrl or Cmd + Home/End are the list's", () => {
  assert.equal(popupListKey(ev("Home"), true), null);
  assert.equal(popupListKey(ev("End"), true), null);
  assert.equal(popupListKey(ev("Home", true), true), "Home");
  assert.equal(popupListKey({ key: "End", ctrlKey: false, metaKey: true }, true), "End");
  assert.equal(popupListKey(ev("ArrowDown"), true), "ArrowDown");
  assert.equal(popupListKey(ev("Tab"), true), null);
});

test("popupListKey: in a list with no text field plain Home/End jump", () => {
  assert.equal(popupListKey(ev("Home"), false), "Home");
  assert.equal(popupListKey(ev("End"), false), "End");
  assert.equal(popupListKey(ev("ArrowUp"), false), "ArrowUp");
  assert.equal(popupListKey(ev("a"), false), null);
});

test("popupMove: the event's target row under the rule", () => {
  assert.equal(popupMove(ev("End"), true, ids, "a"), null);
  assert.equal(popupMove(ev("End", true), true, ids, "a"), "c");
  assert.equal(popupMove(ev("End"), false, ids, "a"), "c");
  assert.equal(popupMove(ev("ArrowUp"), true, ids, "a"), "c");
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
