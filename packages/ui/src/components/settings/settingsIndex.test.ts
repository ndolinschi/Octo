import assert from "node:assert/strict";
import test from "node:test";
import { SECTIONS, SETTINGS_INDEX, searchSettings, sectionOf } from "./settingsIndex";

test("sectionOf: a known id, else General", () => {
  assert.equal(sectionOf("providers"), "providers");
  assert.equal(sectionOf(""), "general");
  assert.equal(sectionOf(null), "general");
  assert.equal(sectionOf("nope"), "general");
  assert.equal(sectionOf("agents"), "providers");
});

test("searchSettings: every word must match, across sections and keywords", () => {
  assert.deepEqual(
    searchSettings("upstream key").map((r) => r.id),
    ["upstream-key"],
  );
  assert.deepEqual(
    searchSettings("COPILOT").map((r) => r.section),
    ["providers", "editor"],
  );
  assert.ok(searchSettings("dark").some((r) => r.id === "theme"));
  assert.deepEqual(searchSettings("   "), []);
  assert.deepEqual(searchSettings("zzz"), []);
});

test("the index: unique ids, every section has a row", () => {
  const ids = SETTINGS_INDEX.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SECTIONS)
    assert.ok(
      SETTINGS_INDEX.some((r) => r.section === s.id),
      s.id,
    );
});
