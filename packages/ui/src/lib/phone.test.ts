import assert from "node:assert/strict";
import test from "node:test";
import { PHONE_MAX_WIDTH, PHONE_QUERY } from "./phone";

test("PHONE_QUERY starts mobile layout at 414px width and landscape coarse-pointer height", () => {
  assert.equal(PHONE_MAX_WIDTH, 414);
  const parts = PHONE_QUERY.split(",").map((s) => s.trim());
  assert.deepEqual(parts, ["(max-width: 414px)", "(max-height: 414px) and (pointer: coarse)"]);
});
