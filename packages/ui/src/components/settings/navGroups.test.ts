import assert from "node:assert/strict";
import test from "node:test";
import { navGroups, NAV_GROUPS } from "./navGroups";
import { SECTIONS } from "./settingsIndex";

test("every settings section is in exactly one group", () => {
  const ids = navGroups().flatMap((g) => g.sections.map((s) => s.id));
  assert.equal(ids.length, SECTIONS.length);
  assert.deepEqual([...ids].sort(), SECTIONS.map((s) => s.id).sort());
  assert.equal(new Set(NAV_GROUPS.flatMap((g) => g.ids)).size, NAV_GROUPS.flatMap((g) => g.ids).length);
});

test("the groups and their labels", () => {
  const groups = navGroups();
  assert.deepEqual(
    groups.map((g) => g.title),
    ["App", "Models and agents", "Workspace"],
  );
  assert.equal(groups[2]?.sections.find((s) => s.id === "usage")?.label, "Usage and budget");
});
