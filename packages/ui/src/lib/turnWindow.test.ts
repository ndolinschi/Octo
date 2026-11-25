import assert from "node:assert/strict";
import test from "node:test";
import { estimateReplyHeight, estimateTurnHeight, keysAround, tailStart, wrappedLines } from "./turnWindow";

test("wrappedLines: each line wraps at the column, empty lines count", () => {
  assert.equal(wrappedLines(""), 0);
  assert.equal(wrappedLines("short"), 1);
  assert.equal(wrappedLines("a\n\nb"), 3);
  assert.equal(wrappedLines("x".repeat(181)), 3);
});

test("estimateReplyHeight: prose at 24 a line, a fenced block as a card of 20px lines", () => {
  assert.equal(estimateReplyHeight(""), 0);
  assert.equal(estimateReplyHeight("one line"), 24);
  const code = "Intro\n\n```go\nfunc a() {}\nfunc b() {}\n```\n";
  assert.equal(estimateReplyHeight(code), 24 + 56 + 2 * 20);
});

test("estimateTurnHeight: the prompt is clamped at eight lines; tool rows add up", () => {
  const long = Array.from({ length: 30 }, () => "line").join("\n");
  assert.equal(estimateTurnHeight(long, "", 0), estimateTurnHeight(Array.from({ length: 8 }, () => "x").join("\n"), "", 0));
  assert.ok(estimateTurnHeight("q", "a", 3) > estimateTurnHeight("q", "a", 0));
  assert.ok(estimateTurnHeight("", "a", 0) < estimateTurnHeight("q", "a", 0), "a turn without a prompt has no bubble");
});

test("tailStart: covers the screens from the end, at least the minimum", () => {
  assert.equal(tailStart([], 900), 0);
  assert.equal(tailStart([100, 100, 100], 900), 0, "everything when it all fits");
  const many = Array.from({ length: 100 }, () => 300);
  // 2.5 screens of 900 = 2250 → 8 turns of 300 (2400).
  assert.equal(tailStart(many, 900), 92);
  assert.equal(tailStart([5000, 5000, 5000, 5000, 5000], 900), 2, "never fewer than three");
  assert.equal(tailStart(many, 900, 1, 1), 97);
});

test("keysAround: the target and its neighbours, clipped at the ends", () => {
  const keys = ["a", "b", "c", "d"];
  assert.deepEqual(keysAround(keys, 0), ["a", "b"]);
  assert.deepEqual(keysAround(keys, 2), ["b", "c", "d"]);
  assert.deepEqual(keysAround(keys, 3, 2), ["b", "c", "d"]);
});
