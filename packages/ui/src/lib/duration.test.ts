import assert from "node:assert/strict";
import test from "node:test";
import { formatStepDuration } from "./duration";

test("a step's time: tenths under ten seconds, then whole seconds and minutes", () => {
  assert.equal(formatStepDuration(40), "<0.1s");
  assert.equal(formatStepDuration(400), "0.4s");
  assert.equal(formatStepDuration(1949), "1.9s");
  assert.equal(formatStepDuration(9999), "9.9s");
  assert.equal(formatStepDuration(10_400), "10s");
  assert.equal(formatStepDuration(65_000), "1m 05s");
  assert.equal(formatStepDuration(3_660_000), "1h 01m");
});
