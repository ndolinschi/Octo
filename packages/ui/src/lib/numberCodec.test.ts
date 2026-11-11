import assert from "node:assert/strict";
import test from "node:test";
import { numberCodec } from "./storage";

const codec = numberCodec(280, 4000, 420);

test("missing, empty or foreign text reads as the default", () => {
  for (const raw of [null, "", "  ", "abc", "NaN"]) assert.equal(codec.parse(raw), 420);
});

test("a number is clamped into its range and written rounded", () => {
  assert.equal(codec.parse("500"), 500);
  assert.equal(codec.parse("12"), 280);
  assert.equal(codec.parse("99999"), 4000);
  assert.equal(codec.stringify(512.6), "513");
});
