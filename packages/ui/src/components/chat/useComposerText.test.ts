import assert from "node:assert/strict";
import test from "node:test";
import { fitHeight } from "./useComposerText";

test("desktop without field-sizing: one to ten lines of 22", () => {
  assert.equal(fitHeight(10, "22px", "22px", "none"), 22);
  assert.equal(fitHeight(66, "22px", "22px", "none"), 66);
  assert.equal(fitHeight(500, "22px", "22px", "none"), 220);
});

test("phone: capped by the CSS max-height, not by ten lines", () => {
  assert.equal(fitHeight(140, "20px", "20px", "120px"), 120);
  assert.equal(fitHeight(220, "20px", "20px", "120px"), 120);
  // A short visible height (keyboard up): 20% of it.
  assert.equal(fitHeight(100, "20px", "20px", "84.4px"), 84.4);
});

test("phone: the empty field is one 20px line", () => {
  assert.equal(fitHeight(20, "20px", "20px", "120px"), 20);
  assert.equal(fitHeight(40, "20px", "20px", "120px"), 40);
});

test("unparsable values fall back to the composer's line", () => {
  assert.equal(fitHeight(5, "normal", "auto", "none"), 22);
  assert.equal(fitHeight(1000, "normal", "0px", "none"), 220);
});
