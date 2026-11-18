import assert from "node:assert/strict";
import test from "node:test";
import { titleFromRequest } from "./title";

test("titleFromRequest cuts at a word with an ellipsis, as the harness does", () => {
  const long = "Run the API tests and lint, then raise the HTTP retry limit to 5 and log each retry with its delay";
  assert.equal(titleFromRequest(long), "Run the API tests and lint, then raise the HTTP retry limit to 5 and log each…");
  assert.equal(titleFromRequest("a".repeat(80)), "a".repeat(80));
  assert.equal(titleFromRequest(`${"a".repeat(80)} tail`), `${"a".repeat(80)}…`);
  assert.equal(titleFromRequest("b".repeat(90)), `${"b".repeat(80)}…`);
  assert.equal(titleFromRequest("Fix it\nmore"), "Fix it");
  assert.equal(titleFromRequest("  "), "New session");
});
