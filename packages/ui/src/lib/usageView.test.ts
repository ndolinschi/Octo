import assert from "node:assert/strict";
import test from "node:test";
import { isUsageView, usageRangeText } from "./usageView";

test("usageRangeText names the range, and the scope only when it is all projects", () => {
  assert.equal(usageRangeText({ days: 30, scope: "project" }), "30 days");
  assert.equal(usageRangeText({ days: 7, scope: "all" }), "7 days, all projects");
});

test("isUsageView rejects unknown values", () => {
  assert.equal(isUsageView({ segment: "tokens", days: 30, scope: "project" }), true);
  assert.equal(isUsageView({ segment: "tokens", days: 14, scope: "project" }), false);
  assert.equal(isUsageView(null), false);
});
