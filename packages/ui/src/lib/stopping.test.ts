import assert from "node:assert/strict";
import test from "node:test";
import { clearStopping, markStopping, stoppingSince } from "./stopping";

test("G5: a pressed Stop holds per project while the turn runs, keeps its first time, and clears", () => {
  markStopping("p1", 1000);
  markStopping("p1", 2000);
  assert.equal(stoppingSince("p1", true), 1000);
  // Another project, and a turn that no longer runs, are not stopping.
  assert.equal(stoppingSince("p2", true), null);
  assert.equal(stoppingSince("p1", false), null);
  assert.equal(stoppingSince(null, true), null);
  clearStopping("p1");
  assert.equal(stoppingSince("p1", true), null);
});
