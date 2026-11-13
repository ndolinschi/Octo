import assert from "node:assert/strict";
import test from "node:test";
import { MIDDLE_MIN_LENGTH, middleSplit } from "./truncate";

test("a short label is not split", () => {
  assert.equal(middleSplit("x".repeat(MIDDLE_MIN_LENGTH)), null);
});

test("a long label keeps up to eight characters at its end", () => {
  assert.deepEqual(middleSplit("product-configuration-manager"), { head: "product-configuration", tail: "-manager" });
});

test("the tail is a third of a medium label", () => {
  const split = middleSplit("abcdefghijklmnopq");
  assert.ok(split);
  assert.equal(split.tail.length, 5);
  assert.equal(split.head + split.tail, "abcdefghijklmnopq");
});
