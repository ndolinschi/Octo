import assert from "node:assert/strict";
import test from "node:test";
import { activate, fileTab, open, resize, toolTab, initialLayout, CHAT, groupOf, type Layout } from "./layout";
import { maximisedGroup, toggleMaximise } from "./maximise";
import { fileKey } from "../../lib/files";

function two(): Layout {
  const l = initialLayout();
  const home = l.groups[0];
  assert.ok(home);
  return open(l, toolTab("review"), { newAfter: home.id, size: 0.5 });
}

test("maximising a tab focuses its group and names it", () => {
  const l = two();
  const g = groupOf(l, toolTab("review"));
  assert.ok(g);
  const next = toggleMaximise(activate(l, CHAT), null, toolTab("review"));
  assert.equal(next.maximised, g.id);
  assert.equal(next.layout.focused, g.id);
  assert.equal(maximisedGroup(next.layout, next.maximised, false), g.id);
});

test("the same toggle restores, and the layout is exactly what it was", () => {
  const l = resize(two(), 0, 0.1, 0.1);
  const on = toggleMaximise(l, null, toolTab("review"));
  const off = toggleMaximise(on.layout, on.maximised, toolTab("review"));
  assert.equal(off.maximised, null);
  assert.deepEqual(
    off.layout.groups.map((g) => [g.tabs, g.active, g.size]),
    l.groups.map((g) => [g.tabs, g.active, g.size]),
  );
});

test("explicit on and off do not flip", () => {
  const l = two();
  const on = toggleMaximise(l, null, toolTab("review"), true);
  assert.equal(toggleMaximise(on.layout, on.maximised, toolTab("review"), true).maximised, on.maximised);
  assert.equal(toggleMaximise(on.layout, on.maximised, toolTab("review"), false).maximised, null);
  assert.equal(toggleMaximise(l, null, toolTab("review"), false).maximised, null);
});

test("focus moving to another group, a missing group or narrow mode means not maximised", () => {
  const l = two();
  const on = toggleMaximise(l, null, toolTab("review"));
  assert.equal(maximisedGroup(activate(on.layout, CHAT), on.maximised, false), null);
  assert.equal(maximisedGroup(on.layout, "gone", false), null);
  assert.equal(maximisedGroup(on.layout, on.maximised, true), null);
  assert.equal(maximisedGroup(on.layout, null, false), null);
});

test("a tab that is not open changes nothing", () => {
  const l = two();
  assert.deepEqual(toggleMaximise(l, null, fileTab(fileKey("f", "a.ts"))), { layout: l, maximised: null });
});
