import assert from "node:assert/strict";
import test from "node:test";
import { listKeyTarget } from "./focus";

test("list keys: arrows clamp at the ends, Home/End jump, other keys do nothing", () => {
  assert.equal(listKeyTarget("ArrowDown", 0, 3), 1);
  assert.equal(listKeyTarget("ArrowDown", 2, 3), 2);
  assert.equal(listKeyTarget("ArrowUp", 0, 3), 0);
  assert.equal(listKeyTarget("Home", 2, 3), 0);
  assert.equal(listKeyTarget("End", 0, 3), 2);
  assert.equal(listKeyTarget("Enter", 0, 3), null);
  assert.equal(listKeyTarget("End", 0, 0), null);
});
