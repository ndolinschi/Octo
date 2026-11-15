import assert from "node:assert/strict";
import test from "node:test";
import { markInitial } from "./providerMark";

test("markInitial: no letter under 9px; whole pixels above", () => {
  assert.equal(markInitial(14), null);
  assert.equal(markInitial(16), null);
  assert.deepEqual(markInitial(20), { px: 9, units: 7.2 });
  assert.equal(markInitial(32)?.px, 15);
});
