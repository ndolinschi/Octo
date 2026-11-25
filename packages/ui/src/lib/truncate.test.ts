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

test("a space at the cut stays visible: it opens the tail as a no-break space", () => {
  const visible = (s: { head: string; tail: string }) => (s.head + s.tail).replace(/ /g, " ");
  for (const text of ["Claude Code · Sonnet", "Claude Code · Sonnet 5.5", "Claude Code · Opus 5.5 · 58k in / 2.8k out", "Claude Code · Opus"]) {
    const split = middleSplit(text);
    assert.ok(split, text);
    assert.equal(visible(split), text);
    // Neither span has a collapsible space at the cut.
    assert.doesNotMatch(split.head, /\s$/u, text);
    assert.doesNotMatch(split.tail, /^ /, text);
  }
  assert.deepEqual(middleSplit("Claude Code · Sonnet"), { head: "Claude Code ·", tail: " Sonnet" });
  assert.deepEqual(middleSplit("Claude Code · Opus 5.5 · 58k in / 2.8k out"), { head: "Claude Code · Opus 5.5 · 58k in /", tail: " 2.8k out" });
});
