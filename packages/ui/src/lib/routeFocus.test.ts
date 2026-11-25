import test from "node:test";
import assert from "node:assert/strict";
import { routeFocusTarget } from "./routeFocus";

test("entering Settings focuses its title; leaving it, the control that opened it; anything else, nothing here", () => {
  assert.equal(routeFocusTarget(false, true), "title");
  assert.equal(routeFocusTarget(true, false), "opener");
  assert.equal(routeFocusTarget(false, false), null);
  assert.equal(routeFocusTarget(true, true), null);
});
