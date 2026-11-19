import assert from "node:assert/strict";
import test from "node:test";
import { firstTrue } from "./bisect";

test("firstTrue finds the first index of a monotone predicate", () => {
  const xs = [1, 3, 3, 7, 9];
  assert.equal(
    firstTrue(xs.length, (i) => (xs[i] ?? 0) >= 3),
    1,
  );
  assert.equal(
    firstTrue(xs.length, (i) => (xs[i] ?? 0) > 3),
    3,
  );
  assert.equal(
    firstTrue(xs.length, (i) => (xs[i] ?? 0) > 9),
    5,
  );
  assert.equal(
    firstTrue(xs.length, () => true),
    0,
  );
  assert.equal(
    firstTrue(0, () => true),
    0,
  );
});
