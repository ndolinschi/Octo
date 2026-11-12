import assert from "node:assert/strict";
import test from "node:test";
import { composerSpans, hasHighlights } from "./mentions";

const kinds = (text: string) => composerSpans(text).map((s) => `${s.kind}:${s.text}`);

test("a file mention is a span; the spans cover the whole text", () => {
  const text = "look at @src/lib/format.ts, then run it";
  assert.deepEqual(kinds(text), ["text:look at ", "mention:@src/lib/format.ts", "text:, then run it"]);
  assert.equal(
    composerSpans(text)
      .map((s) => s.text)
      .join(""),
    text,
  );
});

test("a handle without a path or extension stays plain", () => {
  assert.deepEqual(kinds("ping @maya please"), ["text:ping @maya please"]);
  assert.equal(hasHighlights(composerSpans("ping @maya")), false);
});

test("an email address is not a mention (the @ is not at a word start)", () => {
  assert.deepEqual(kinds("write to maya@octo.dev"), ["text:write to maya@octo.dev"]);
});

test("known slash commands highlight, unknown ones do not", () => {
  assert.deepEqual(kinds("/settings"), ["command:/settings"]);
  assert.deepEqual(kinds("open /files now"), ["text:open ", "command:/files", "text: now"]);
  assert.deepEqual(kinds("/frobnicate"), ["text:/frobnicate"]);
  assert.deepEqual(kinds("see src/files/x"), ["text:see src/files/x"]);
});

test("newlines separate words and an empty text has no spans", () => {
  assert.deepEqual(kinds("a\n@README.md"), ["text:a\n", "mention:@README.md"]);
  assert.deepEqual(composerSpans(""), []);
});
