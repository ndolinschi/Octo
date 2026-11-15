import assert from "node:assert/strict";
import test from "node:test";
import {
  walkPress,
  walkRelease,
  CLOSED_MAX,
  TAB_GAP,
  TAB_MAX,
  stripPlan,
  endPlan,
  TAB_MIN,
  clampLeft,
  insertionIndex,
  jumpIndex,
  mruOrder,
  mruTouch,
  pushClosed,
  slotShift,
  tabsOverflow,
  takeClosed,
  toMoveIndex,
  fitStrip,
  shownToLayoutIndex,
  tabFloor,
  tabWant,
  TAB_CLOSE_ROOM,
  TAB_FLOOR,
} from "./tabStrip";

test("overflow (decision 83): tabs shrink to TAB_MIN each before the strip scrolls", () => {
  assert.equal(tabsOverflow(0, 5), false, "unmeasured");
  assert.equal(tabsOverflow(1000, 1), false);
  assert.equal(tabsOverflow(5 * TAB_MIN + 4 * TAB_GAP, 5), false, "exactly fits");
  assert.equal(tabsOverflow(5 * TAB_MIN + 4 * TAB_GAP - 1, 5), true);
  assert.equal(tabsOverflow(10, 0), false);
  assert.ok(TAB_MIN < TAB_MAX);
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

test("strip plan (decision 90): pinned buttons fold first, then inactive tabs give up the close place", () => {
  assert.deepEqual(stripPlan({ room: 0, wanted: 500, pinned: 200, collapsed: false }), { collapse: false, overlay: false }, "unmeasured");
  assert.deepEqual(stripPlan({ room: 600, wanted: 500, pinned: 200, collapsed: false }), { collapse: false, overlay: false });
  assert.deepEqual(stripPlan({ room: 400, wanted: 500, pinned: 200, collapsed: false }), { collapse: true, overlay: false }, "600 once folded");
  // Folded: the room already contains the freed width; the decision does not flip back.
  assert.deepEqual(stripPlan({ room: 600, wanted: 500, pinned: 200, collapsed: true }), { collapse: true, overlay: false });
  assert.deepEqual(stripPlan({ room: 600, wanted: 400, pinned: 200, collapsed: true }), { collapse: false, overlay: false }, "fits beside the buttons again");
  assert.deepEqual(stripPlan({ room: 400, wanted: 700, pinned: 200, collapsed: false }), { collapse: true, overlay: true });
  assert.deepEqual(stripPlan({ room: 400, wanted: 700, pinned: 0, collapsed: false }), { collapse: false, overlay: true }, "no pinned buttons");
});

test("endPlan folds the agents first, then Run, and does not flap", () => {
  const e = { tabs: 1, agents: 60, run: 32, agentsCompact: false, runCompact: false };
  assert.deepEqual(endPlan({ ...e, room: 0 }), { agentsCompact: false, runCompact: false }, "unmeasured");
  assert.deepEqual(endPlan({ ...e, room: 120 }), { agentsCompact: false, runCompact: false }, "fits");
  assert.deepEqual(endPlan({ ...e, room: 90 }), { agentsCompact: true, runCompact: false }, "agents first");
  assert.deepEqual(endPlan({ ...e, room: 25 }), { agentsCompact: true, runCompact: true }, "then Run");
  assert.deepEqual(endPlan({ ...e, room: 150, agentsCompact: true, runCompact: true }), { agentsCompact: true, runCompact: false }, "Run comes back first");
  assert.deepEqual(endPlan({ ...e, room: 190, agentsCompact: true, runCompact: true }), { agentsCompact: false, runCompact: false }, "everything fits again");
  assert.deepEqual(endPlan({ ...e, room: 96, agents: 0 }), { agentsCompact: false, runCompact: false }, "nothing to fold");
  assert.deepEqual(endPlan({ ...e, tabs: 3, room: 196, agents: 0 }), { agentsCompact: false, runCompact: true }, "three tabs: Run folds");
});

/* C2 (V3): only whole tabs; the rest in "All tabs". Tools are ~70–100px of parts and title; a file with a long name ~260. */
const tool = (id: string, natural = 80, o: { keep?: boolean; close?: boolean } = {}) => ({ id, natural, close: o.close ?? true, keep: o.keep ?? false });

test("fitStrip: a tab is never drawn narrower than its whole title, a long title not below TAB_FLOOR", () => {
  assert.equal(tabWant(80, true), 80 + TAB_CLOSE_ROOM);
  assert.equal(tabFloor(80, true), 80 + TAB_CLOSE_ROOM, "a short title keeps all of itself and the close place");
  assert.equal(tabFloor(50, false), TAB_MIN, "decision 83: never under TAB_MIN");
  assert.equal(tabFloor(300, true), TAB_FLOOR, "a long file name truncates, but not below the floor");
  assert.equal(tabWant(400, true), TAB_MAX);
});

test("fitStrip: everything fits → all shown; unmeasured or unmeasured room → all shown", () => {
  const tabs = ["a", "b", "c"].map((id) => tool(id));
  assert.deepEqual(fitStrip({ room: 1000, tabs, recent: [], allRoom: 40 }), { shown: ["a", "b", "c"], hidden: 0 });
  assert.deepEqual(fitStrip({ room: 3 * 104 + 2 * TAB_GAP, tabs, recent: [], allRoom: 40 }).hidden, 0, "exactly fits");
  assert.deepEqual(fitStrip({ room: 0, tabs, recent: [], allRoom: 40 }).hidden, 0);
  assert.deepEqual(fitStrip({ room: 100, tabs: [...tabs, { id: "d", natural: undefined, close: true, keep: false }], recent: [], allRoom: 40 }).hidden, 0);
});

test("fitStrip: short → the active tab stays, then the most recent ones; strip order kept; the oldest go to All tabs", () => {
  const tabs = ["files", "changes", "memory", "notes", "usage", "agents"].map((id) => tool(id, 80, { keep: id === "agents" }));
  // 104 each; room for the "All tabs" button (40) and three tabs: 3 * 104 + 2 * 4 = 320.
  const r = fitStrip({ room: 360, tabs, recent: ["agents", "files", "usage", "notes"], allRoom: 40 });
  assert.deepEqual(r, { shown: ["files", "usage", "agents"], hidden: 3 });
  const never = fitStrip({ room: 360, tabs, recent: [], allRoom: 40 });
  assert.deepEqual(never.shown, ["files", "changes", "agents"], "never-used tabs: strip order after the kept one");
});

test("fitStrip: a big recent tab that does not fit leaves room to a smaller older one", () => {
  const tabs = [tool("a", 80, { keep: true }), tool("long-file", 400), tool("b", 80)];
  const r = fitStrip({ room: 104 + 4 + 104 + 40 + 20, tabs, recent: ["a", "long-file", "b"], allRoom: 40 });
  assert.deepEqual(r, { shown: ["a", "b"], hidden: 1 });
});

test("fitStrip: the active tab is shown even when it alone is wider than the room", () => {
  const r = fitStrip({ room: 60, tabs: [tool("a"), tool("b", 80, { keep: true })], recent: ["a"], allRoom: 40 });
  assert.deepEqual(r, { shown: ["b"], hidden: 1 });
});

test("shownToLayoutIndex: a drag index over the shown tabs → the group's index", () => {
  const all = ["a", "b", "c", "d", "e"];
  assert.equal(shownToLayoutIndex(all, all, 3), 3, "identity when nothing is hidden");
  const shown = ["a", "c", "e"];
  assert.equal(shownToLayoutIndex(shown, all, 0), 0, "before a");
  assert.equal(shownToLayoutIndex(shown, all, 1), 2, "before c");
  assert.equal(shownToLayoutIndex(shown, all, 2), 4, "before e");
  assert.equal(shownToLayoutIndex(shown, all, 3), 5, "after the last shown");
  // Narrow (one strip for every group): a shown tab from another group is skipped.
  assert.equal(shownToLayoutIndex(["x", "a", "y", "c"], ["a", "b", "c"], 2), 2, "before c, past the other group's y");
  assert.equal(shownToLayoutIndex(["a", "x"], ["a", "b"], 1), 1, "after a when nothing of the group follows");
});
