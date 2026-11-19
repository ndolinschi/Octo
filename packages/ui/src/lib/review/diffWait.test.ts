import assert from "node:assert/strict";
import test from "node:test";
import { DIFF_WAIT_START, diffWait } from "./diffWait";

test("new models wait until the diff is computed", () => {
  const waiting = diffWait(DIFF_WAIT_START, { type: "model", seq: 1 });
  assert.deepEqual(waiting, { seq: 1, pending: true });
  assert.deepEqual(diffWait(waiting, { type: "computed" }), { seq: 1, pending: false });
});

test("the timeout ends the wait of its own models only", () => {
  const second = diffWait(diffWait(DIFF_WAIT_START, { type: "model", seq: 1 }), { type: "model", seq: 2 });
  assert.equal(diffWait(second, { type: "timeout", seq: 1 }).pending, true);
  assert.equal(diffWait(second, { type: "timeout", seq: 2 }).pending, false);
});

test("a computed diff or a timeout with nothing pending changes nothing", () => {
  assert.equal(diffWait(DIFF_WAIT_START, { type: "computed" }), DIFF_WAIT_START);
  assert.equal(diffWait(DIFF_WAIT_START, { type: "timeout", seq: 0 }), DIFF_WAIT_START);
});
