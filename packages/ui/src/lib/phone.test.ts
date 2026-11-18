import assert from "node:assert/strict";
import test from "node:test";
import { PHONE_QUERY } from "./phone";

test("PHONE_QUERY covers portrait phones, landscape coarse-pointer phones, and narrow desktop windows", () => {
  const parts = PHONE_QUERY.split(",").map((s) => s.trim());
  assert.deepEqual(parts, ["(max-width: 640px) and (pointer: coarse)", "(max-height: 479.98px) and (pointer: coarse)", "(max-width: 479.98px)"]);
});
