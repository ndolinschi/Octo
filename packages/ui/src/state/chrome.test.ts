import assert from "node:assert/strict";
import test from "node:test";
import { controlsPadding, ROW_HEIGHT } from "./chrome";

test("no centre line, or the row's own, adds no padding", () => {
  assert.deepEqual(controlsPadding(undefined), { top: 0, bottom: 0 });
  assert.deepEqual(controlsPadding(ROW_HEIGHT / 2), { top: 0, bottom: 0 });
  assert.deepEqual(controlsPadding(Number.NaN), { top: 0, bottom: 0 });
});

test("a centre below the row's middle pads the top by twice the shift, above it the bottom", () => {
  assert.deepEqual(controlsPadding(23), { top: 6, bottom: 0 });
  assert.deepEqual(controlsPadding(14), { top: 0, bottom: 12 });
});

test("the shift stays inside the row", () => {
  assert.deepEqual(controlsPadding(500), { top: 20, bottom: 0 });
  assert.deepEqual(controlsPadding(-500), { top: 0, bottom: 20 });
});
