import assert from "node:assert/strict";
import test from "node:test";
import { sectionBackStep } from "./sectionBack";

test("sectionBackStep: a layer or a section opened from the list goes back in history; else the list replaces it", () => {
  assert.equal(sectionBackStep(true, false), "history");
  assert.equal(sectionBackStep(false, true), "history");
  assert.equal(sectionBackStep(true, true), "history");
  assert.equal(sectionBackStep(false, false), "list");
});
