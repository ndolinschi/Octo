import assert from "node:assert/strict";
import test from "node:test";
import { composerSpans, hasHighlights } from "./mentions";

const kinds = (text: string) => composerSpans(text).map((s) => `${s.kind}:${s.text}`);
const kinds2 = (text: string, names: readonly string[]) => composerSpans(text, names).map((s) => `${s.kind}:${s.text}`);

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

test("a known command at the start of the text highlights; unknown ones do not", () => {
  assert.deepEqual(kinds("/settings"), ["command:/settings"]);
  assert.deepEqual(kinds("/context"), ["command:/context"]);
  assert.deepEqual(kinds("/remember we deploy"), ["command:/remember", "text: we deploy"]);
  assert.deepEqual(kinds("  /clear"), ["text:  ", "command:/clear"]);
  assert.deepEqual(kinds("/frobnicate"), ["text:/frobnicate"]);
  assert.deepEqual(kinds("/files"), ["text:/files"]);
  assert.deepEqual(kinds("see src/files/x"), ["text:see src/files/x"]);
});

test("a command in mid-sentence does not highlight (it would not run there)", () => {
  assert.deepEqual(kinds("open /settings now"), ["text:open /settings now"]);
  assert.deepEqual(kinds("/context then @src/auth/refresh.ts and /files and /clear"), [
    "command:/context",
    "text: then ",
    "mention:@src/auth/refresh.ts",
    "text: and /files and /clear",
  ]);
});

test("a caller's own command names replace the Octo ones", () => {
  assert.deepEqual(kinds2("/init", ["init"]), ["command:/init"]);
  assert.deepEqual(kinds2("/clear", ["init"]), ["text:/clear"]);
});

test("newlines separate words and an empty text has no spans", () => {
  assert.deepEqual(kinds("a\n@README.md"), ["text:a\n", "mention:@README.md"]);
  assert.deepEqual(composerSpans(""), []);
});

test("markdown elements highlight while preserving exact character sequence", () => {
  const sample = [
    "# Heading with @pom.xml",
    "Track #bug-42 with **bold**, *em*, `code`, and [docs](https://example.com).",
    "> Quote line",
    "- List item",
    "```ts",
    "const #notTag = '@ignored';",
    "```",
  ].join("\n");
  const spans = composerSpans(sample);
  assert.equal(spans.map((s) => s.text).join(""), sample);
  assert.deepEqual(
    spans.slice(0, 6).map((s) => `${s.kind}:${s.text}`),
    ["md-heading:# Heading with ", "mention:@pom.xml", "text:\nTrack ", "md-tag:#bug-42", "text: with ", "md-strong:**bold**"],
  );
  assert.ok(spans.some((s) => s.kind === "md-em" && s.text === "*em*"));
  assert.ok(spans.some((s) => s.kind === "md-code" && s.text === "`code`"));
  assert.ok(spans.some((s) => s.kind === "md-link" && s.text === "[docs](https://example.com)"));
  assert.ok(spans.some((s) => s.kind === "md-quote" && s.text === "> "));
  assert.ok(spans.some((s) => s.kind === "md-list" && s.text === "-"));
  assert.ok(spans.some((s) => s.kind === "md-code" && s.text.startsWith("```ts")));
  assert.ok(!spans.some((s) => s.kind === "md-tag" && s.text === "#notTag"));
});

test("unique extensionless known files highlight as mentions while handles stay plain", () => {
  const knownFiles = new Set(["Makefile", "Dockerfile"]);
  const text = "Check @Makefile and @maya";
  assert.deepEqual(
    composerSpans(text, undefined, { knownFiles }).map((s) => `${s.kind}:${s.text}`),
    ["text:Check ", "mention:@Makefile", "text: and @maya"],
  );
});
