import assert from "node:assert/strict";
import test from "node:test";
import {
  walkPress,
  walkRelease,
  CLOSED_MAX,
  TAB_ICON,
  TAB_MAX,
  TAB_MIN,
  clampLeft,
  insertionIndex,
  jumpIndex,
  mruOrder,
  mruTouch,
  pushClosed,
  slotShift,
  tabSizing,
  takeClosed,
  toMoveIndex,
} from "./tabStrip";

test("sizing: up to 200 each, shrinking evenly to 96, then icon-only beside a 96px active tab, then overflow", () => {
  assert.deepEqual(tabSizing(1000, 2, 0).widths, [TAB_MAX, TAB_MAX]);
  const even = tabSizing(500, 4, 1);
  assert.deepEqual(even.widths, [122, 122, 122, 122]);
  assert.equal(even.overflow, false);
  const icons = tabSizing(400, 6, 2);
  assert.deepEqual(icons.widths, [TAB_ICON, TAB_ICON, 180, TAB_ICON, TAB_ICON, TAB_ICON], "the active tab takes the rest");
  assert.equal(tabSizing(260, 6, 0).widths[0], TAB_MIN, "never below 96");
  assert.deepEqual(icons.iconOnly, [true, true, false, true, true, true]);
  assert.equal(icons.overflow, false);
  assert.equal(tabSizing(200, 12, 0).overflow, true);
  assert.deepEqual(tabSizing(0, 3, 0).widths, [TAB_MAX, TAB_MAX, TAB_MAX], "unmeasured: full width");
});

const slots = [0, 1, 2, 3].map((i) => ({ left: i * 104, width: 100 }));

test("insertion index: neighbours yield as the dragged centre passes theirs; pinned tabs never move", () => {
  // Dragging tab 1 (centre 154) right past tab 2's centre (258).
  assert.equal(insertionIndex(slots, 1, 200, 0), 1);
  assert.equal(insertionIndex(slots, 1, 260, 0), 2);
  assert.equal(insertionIndex(slots, 1, 999, 0), 3);
  assert.equal(insertionIndex(slots, 2, -50, 1), 1, "never before the pinned Orchestrator tab");
  assert.equal(insertionIndex(slots, -1, 60, 0), 1, "from another strip");
});

test("slot shift: the tabs between the old and new slot move one step the other way", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => slotShift(i, 1, 3, 104)),
    [0, 0, -104, -104],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => slotShift(i, 3, 1, 104)),
    [0, 104, 104, 0],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => slotShift(i, -1, 2, 104)),
    [0, 0, 104, 104],
    "a gap opens for a foreign tab",
  );
  assert.deepEqual(
    [0, 1, 2].map((i) => slotShift(i, 1, 1, 104)),
    [0, 0, 0],
  );
});

test("toMoveIndex converts to layout.move's index; clampLeft keeps the tab in its strip", () => {
  assert.equal(toMoveIndex(1, 3), 4);
  assert.equal(toMoveIndex(3, 1), 1);
  assert.equal(toMoveIndex(-1, 2), 2);
  assert.equal(clampLeft(-20, 100, 0, 500), 0);
  assert.equal(clampLeft(450, 100, 0, 500), 400);
  assert.equal(clampLeft(120, 100, 0, 500), 120);
});

test("MRU: touch moves to the front; order puts unused tabs after, in strip order", () => {
  assert.deepEqual(mruTouch(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(mruOrder(["c", "x", "a"], ["a", "b", "c", "d"]), ["c", "a", "b", "d"]);
});

test("closed stack keeps the last 20 and skips tabs that are open again", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ tab: `t${i}`, group: "g", index: i }));
  const stack = pushClosed([], many);
  assert.equal(stack.length, CLOSED_MAX);
  assert.equal(stack[0]?.tab, "t5");
  const { entry, rest } = takeClosed(stack, (t) => t === "t24");
  assert.equal(entry?.tab, "t23");
  assert.equal(rest.length, CLOSED_MAX - 2);
  assert.equal(takeClosed([], () => false).entry, null);
});

test("Ctrl+1…8 by position, 9 = the last", () => {
  assert.equal(jumpIndex(1, 3), 0);
  assert.equal(jumpIndex(3, 3), 2);
  assert.equal(jumpIndex(4, 3), null);
  assert.equal(jumpIndex(9, 3), 2);
  assert.equal(jumpIndex(9, 0), null);
});

test("Ctrl+Tab twice across a split stays in the first group and commits on release", () => {
  // Side group MRU: Agents (active), Usage, Notes. The first press fixes it; the second press arrives after focus
  // moved to the other group (its order is offered again) and must keep walking the first one.
  const first = walkPress(null, { group: "side", order: ["Agents", "Usage", "Notes"] }, false);
  assert.equal(first.target, "Usage");
  const second = walkPress(first.walk, { group: "main", order: ["Orchestrator", "Reviewer"] }, false);
  assert.equal(second.target, "Notes");
  assert.equal(second.walk.group, "side");
  assert.equal(walkRelease(second.walk), "Notes");
  assert.equal(walkPress(second.walk, { group: "side", order: [] }, true).target, "Usage", "Shift steps back");
  assert.equal(walkRelease(null), undefined);
});
