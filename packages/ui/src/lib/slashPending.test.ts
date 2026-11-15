import assert from "node:assert/strict";
import test from "node:test";
import { pendingLine } from "./slashPending";

test("clear and compact say what is happening; others answer at once", () => {
  assert.equal(pendingLine("clear"), "Starting a new session…");
  assert.equal(pendingLine("compact"), "Compacting the conversation…");
  assert.equal(pendingLine("mode"), null);
  assert.equal(pendingLine("constructor"), null);
});
