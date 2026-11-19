import assert from "node:assert/strict";
import test from "node:test";
import { appendMention, chatMention, selectedLines } from "./chatMention";
import { composerSpans } from "./mentions";

test("chatMention: a file, a line, a range", () => {
  assert.equal(chatMention("src/auth/refresh.ts"), "@src/auth/refresh.ts");
  assert.equal(chatMention("/src/a.ts", { from: 9, to: 9 }), "@src/a.ts:9");
  assert.equal(chatMention("src/a.ts", { from: 9, to: 14 }), "@src/a.ts:9-14");
});

test("selectedLines: an empty selection is its line; a trailing column 1 does not count", () => {
  assert.deepEqual(selectedLines({ startLine: 7, startColumn: 3, endLine: 7, endColumn: 3 }), { from: 7, to: 7 });
  assert.deepEqual(selectedLines({ startLine: 9, startColumn: 1, endLine: 15, endColumn: 1 }), { from: 9, to: 14 });
  assert.deepEqual(selectedLines({ startLine: 9, startColumn: 4, endLine: 12, endColumn: 2 }), { from: 9, to: 12 });
});

test("appendMention adds one space before and after", () => {
  assert.equal(appendMention("", "@a.ts:1"), "@a.ts:1 ");
  assert.equal(appendMention("Look at", "@a.ts:1"), "Look at @a.ts:1 ");
  assert.equal(appendMention("Look at  \n", "@a.ts"), "Look at @a.ts ");
});

test("the composer reads the mention with its range as one mention", () => {
  const spans = composerSpans("Why @src/a.ts:9-14 ?");
  assert.ok(spans.some((s) => s.kind === "mention" && s.text === "@src/a.ts:9-14"));
});
