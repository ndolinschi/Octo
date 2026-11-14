import assert from "node:assert/strict";
import test from "node:test";
import {
  highlightable,
  hasLongWord,
  plainShaping,
  PLAIN_SHAPING_CHARS,
  LONG_WORD_CHARS,
  HIGHLIGHT_MAX_CHARS,
  mayNearLimit,
  triggerAt,
  TRIGGER_WINDOW,
} from "./composerInput";

test("highlightable: short text yes; too long or with a very long word no", () => {
  assert.equal(highlightable("look at @src/a.ts please"), true);
  assert.equal(highlightable("x".repeat(LONG_WORD_CHARS - 1)), true);
  assert.equal(highlightable(`see ${"A".repeat(LONG_WORD_CHARS)} end`), false);
  assert.equal(highlightable("word ".repeat(HIGHLIGHT_MAX_CHARS / 5 + 1)), false);
});

test("hasLongWord: a run of non-space characters of LONG_WORD_CHARS or more", () => {
  assert.equal(hasLongWord("short words only ".repeat(1000)), false);
  assert.equal(hasLongWord(`a\n${"x".repeat(LONG_WORD_CHARS)}`), true);
  assert.equal(hasLongWord("x".repeat(LONG_WORD_CHARS - 1)), false);
  for (const sep of [" ", "\t", "\n", "\u00a0", "\u2003", "\u3000", "\ufeff"]) {
    const text = `${"x".repeat(LONG_WORD_CHARS - 1)}${sep}${"y".repeat(LONG_WORD_CHARS - 1)}`;
    assert.equal(hasLongWord(text), /\S{1000}/.test(text), JSON.stringify(sep));
  }
});

test("plainShaping: a long word, or a very long text", () => {
  assert.equal(plainShaping("hello world"), false);
  assert.equal(plainShaping("x".repeat(LONG_WORD_CHARS)), true);
  assert.equal(plainShaping("ab ".repeat(PLAIN_SHAPING_CHARS / 3 + 1)), true);
});

test("triggerAt: the sigil word at the caret, as the whole-text regex found it", () => {
  assert.deepEqual(triggerAt("@", 1), { start: 0, query: "" });
  assert.deepEqual(triggerAt("hello @src", 10), { start: 6, query: "src" });
  assert.deepEqual(triggerAt("/mod", 4), { start: 0, query: "mod" });
  assert.deepEqual(triggerAt("a\n@x", 4), { start: 2, query: "x" });
  assert.equal(triggerAt("mail@host", 9), null, "inside a word");
  assert.equal(triggerAt("@src done", 9), null, "a space after the query closes it");
  assert.deepEqual(triggerAt("hello @src and more", 10), { start: 6, query: "src" }, "the caret, not the end, counts");
});

test("triggerAt: reads only the window before the caret, in a megabyte of text", () => {
  const big = "A".repeat(2_000_000);
  assert.equal(triggerAt(big, big.length), null, "a long word cut by the window is no trigger");
  const t = `${big} @do`;
  assert.deepEqual(triggerAt(t, t.length), { start: big.length + 1, query: "do" });
  const edge = `${"x".repeat(1000)} @${"q".repeat(TRIGGER_WINDOW)}`;
  assert.equal(triggerAt(edge, edge.length), null, "a query longer than the window is not one");
  const atEdge = `${"x".repeat(1000)} @${"q".repeat(TRIGGER_WINDOW - 1)}`;
  assert.deepEqual(triggerAt(atEdge, atEdge.length), { start: 1001, query: "q".repeat(TRIGGER_WINDOW - 1) }, "a sigil right at the window's start");
});

test("mayNearLimit: by length alone (6 bytes a character at most)", () => {
  assert.equal(mayNearLimit("x".repeat(100_000)), false);
  assert.equal(mayNearLimit("x".repeat(200_000)), true);
});
