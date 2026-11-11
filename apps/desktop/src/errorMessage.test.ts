import assert from "node:assert/strict";
import test from "node:test";
import { errorMessage } from "./errorMessage";

test("errorMessage", () => {
  assert.equal(errorMessage("  The harness did not answer.  "), "The harness did not answer.");
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage(undefined), "The harness could not be started.");
  assert.equal(errorMessage(""), "The harness could not be started.");
});
