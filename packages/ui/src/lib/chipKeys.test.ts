import assert from "node:assert/strict";
import test from "node:test";
import { chipKeyTarget } from "./chipKeys";

test("chipKeyTarget moves along the chips and stops at the ends", () => {
  assert.equal(chipKeyTarget("ArrowRight", 0, 3), 1);
  assert.equal(chipKeyTarget("ArrowLeft", 0, 3), 0);
  assert.equal(chipKeyTarget("ArrowRight", 2, 3), 2);
  assert.equal(chipKeyTarget("End", 0, 3), 2);
  assert.equal(chipKeyTarget("Home", 2, 3), 0);
  assert.equal(chipKeyTarget("Enter", 1, 3), null);
  assert.equal(chipKeyTarget("ArrowRight", 0, 0), null);
});
