import assert from "node:assert/strict";
import test from "node:test";
import { escapeTarget, INITIAL_PANE, isNarrow, LIST_DETAIL_FLOOR, paneReducer } from "./listDetail";

test("picking a row selects it and opens the detail", () => {
  assert.deepEqual(paneReducer(INITIAL_PANE, { type: "pick", id: "a" }), { selected: "a", open: true });
});

test("back keeps the selection and picking the same row opens it again", () => {
  const open = paneReducer(INITIAL_PANE, { type: "pick", id: "a" });
  const back = paneReducer(open, { type: "back" });
  assert.deepEqual(back, { selected: "a", open: false });
  assert.deepEqual(paneReducer(back, { type: "pick", id: "a" }), { selected: "a", open: true });
});

test("back on a closed pane and picking the open row change nothing", () => {
  assert.equal(paneReducer(INITIAL_PANE, { type: "back" }), INITIAL_PANE);
  const open = paneReducer(INITIAL_PANE, { type: "pick", id: "a" });
  assert.equal(paneReducer(open, { type: "pick", id: "a" }), open);
});

test("an owner-side change of the selection opens the detail, the same value does not", () => {
  const s = paneReducer(INITIAL_PANE, { type: "sync", selected: "t1" });
  assert.deepEqual(s, { selected: "t1", open: true });
  assert.equal(paneReducer(s, { type: "sync", selected: "t1" }), s);
  assert.deepEqual(paneReducer(s, { type: "sync", selected: null }), { selected: null, open: false });
});

test("the component's container query uses the same floor", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../components/primitives/ListDetail.tsx", import.meta.url), "utf8");
  assert.ok(source.includes(`@min-[${LIST_DETAIL_FLOOR}px]/ld:`));
  assert.ok(!/@min-\[(?!640px)\d+px\]\/ld:/.test(source));
});

test("the floor and Esc", () => {
  assert.equal(isNarrow(LIST_DETAIL_FLOOR - 1), true);
  assert.equal(isNarrow(LIST_DETAIL_FLOOR), false);
  assert.equal(escapeTarget(true), "back");
  assert.equal(escapeTarget(false), "list");
});
