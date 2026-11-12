import assert from "node:assert/strict";
import test from "node:test";
import { isUsageView, usageRangeText } from "./usageView";

test("usageRangeText names the range, and the scope only when it is all projects", () => {
  assert.equal(usageRangeText({ period: "30d", scope: "project" }), "30 days");
  assert.equal(usageRangeText({ period: "7d", scope: "all" }), "7 days, all projects");
  assert.equal(usageRangeText({ period: "all", scope: "project" }), "All time");
});

test("isUsageView rejects unknown values, including the pre-86 shape", () => {
  assert.equal(isUsageView({ segment: "model", period: "all", scope: "project", roles: false }), true);
  assert.equal(isUsageView({ segment: "model", period: "14d", scope: "project", roles: false }), false);
  assert.equal(isUsageView({ segment: "tokens", days: 30, scope: "project" }), false);
  assert.equal(isUsageView(null), false);
});
