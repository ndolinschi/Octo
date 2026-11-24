import assert from "node:assert/strict";
import test from "node:test";
import { clearKeptChanges, keepAllFiles, keptChangesSnapshot, subscribeKeptChanges, toggleFileKept } from "./keptChanges";

test("keptChanges tracks per-project kept files and notifies subscribers", () => {
  clearKeptChanges("p1");
  clearKeptChanges("p2");

  let calls = 0;
  const unsub = subscribeKeptChanges(() => {
    calls += 1;
  });

  assert.equal(keptChangesSnapshot("p1").size, 0);
  assert.equal(toggleFileKept("p1", "1:src/a.ts"), true);
  assert.equal(keptChangesSnapshot("p1").has("1:src/a.ts"), true);
  assert.equal(keptChangesSnapshot("p2").has("1:src/a.ts"), false);

  keepAllFiles("p1", ["1:src/a.ts", "1:src/b.ts"]);
  assert.equal(keptChangesSnapshot("p1").size, 2);
  const callsBefore = calls;
  // Re-keeping already kept keys is a no-op.
  keepAllFiles("p1", ["1:src/a.ts", "1:src/b.ts"]);
  assert.equal(calls, callsBefore);

  assert.equal(toggleFileKept("p1", "1:src/a.ts"), false);
  assert.equal(keptChangesSnapshot("p1").has("1:src/a.ts"), false);

  unsub();
  clearKeptChanges("p1");
});
