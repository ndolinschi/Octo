import assert from "node:assert/strict";
import test from "node:test";
import { formatComments, linesLabel, requestTitle, splitComments, withComments } from "./comments";

const c = (over: Partial<Parameters<typeof formatComments>[0][number]> = {}) => ({
  folder: "api",
  path: "src/auth/refresh.ts",
  start: 12,
  end: 14,
  lines: ["const a = 1;", "const b = 2;", "const c = 3;"],
  text: "Why not use a constant?",
  ...over,
});

test("the block follows the documented wire format", () => {
  assert.equal(
    formatComments([c()]),
    ["```octo-comments", "api/src/auth/refresh.ts:12-14", "> const a = 1;", "> const b = 2;", "> const c = 3;", "Why not use a constant?", "```"].join("\n"),
  );
});

test("a single line is `path:12`, not a range", () => {
  assert.match(formatComments([c({ start: 7, end: 7, lines: ["x"] })]), /refresh\.ts:7\n> x\n/);
});

test("at most six quoted lines, then `> …`; exactly six has no ellipsis", () => {
  const seven = Array.from({ length: 7 }, (_, i) => `l${i + 1}`);
  const block = formatComments([c({ lines: seven })]);
  assert.ok(block.includes("> l6\n> …\n"));
  assert.ok(!block.includes("l7"));
  const six = formatComments([c({ lines: seven.slice(0, 6) })]);
  assert.ok(!six.includes("…"));
  assert.ok(six.includes("> l6"));
});

test("blank quoted lines carry no trailing space; the comment text is trimmed", () => {
  const block = formatComments([c({ lines: ["a", "", "b"], text: "  hello \n" })]);
  assert.ok(block.includes("> a\n>\n> b\nhello\n"));
});

test("several comments are separated by one blank line, in order", () => {
  const block = formatComments([c({ path: "a.ts", text: "one" }), c({ path: "b.ts", text: "two" })]);
  assert.ok(block.includes("one\n\napi/b.ts:12-14"));
  assert.ok(block.indexOf("a.ts") < block.indexOf("b.ts"));
});

test("the fence grows past any backtick run in the quote or the text", () => {
  assert.ok(formatComments([c()]).startsWith("```octo-comments\n"));
  const withFence = formatComments([c({ text: "use ```ts blocks" })]);
  assert.ok(withFence.startsWith("````octo-comments\n") && withFence.endsWith("\n````"));
  const quoted = formatComments([c({ lines: ["const s = `````x`````;"] })]);
  assert.ok(quoted.startsWith("``````octo-comments\n") && quoted.endsWith("\n``````"));
});

test("withComments appends the block, or is the block alone without prose", () => {
  assert.equal(withComments("  Please fix  ", "BLOCK"), "Please fix\n\nBLOCK");
  assert.equal(withComments("   ", "BLOCK"), "BLOCK");
});

test("splitComments gives back what formatComments wrote", () => {
  const input = [
    c(),
    c({ folder: "web", path: "a b/ü.ts", start: 3, end: 3, lines: ["", "x"], text: "line one\nline two\n\nafter blank" }),
    c({ lines: Array.from({ length: 9 }, (_, i) => `row ${i}`), text: "long" }),
  ];
  const { prose, comments } = splitComments(withComments("Please look", formatComments(input)));
  assert.equal(prose, "Please look");
  assert.deepEqual(comments, [
    {
      folder: "api",
      path: "src/auth/refresh.ts",
      start: 12,
      end: 14,
      quote: ["const a = 1;", "const b = 2;", "const c = 3;"],
      truncated: false,
      text: "Why not use a constant?",
    },
    { folder: "web", path: "a b/ü.ts", start: 3, end: 3, quote: ["", "x"], truncated: false, text: "line one\nline two\n\nafter blank" },
    {
      folder: "api",
      path: "src/auth/refresh.ts",
      start: 12,
      end: 14,
      quote: ["row 0", "row 1", "row 2", "row 3", "row 4", "row 5"],
      truncated: true,
      text: "long",
    },
  ]);
});

test("a grown fence round trips and the backticks stay in the text", () => {
  const { comments } = splitComments(formatComments([c({ text: "see ```js\nx\n```" })]));
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.text, "see ```js\nx\n```");
});

test("text without a block, or an unterminated one, is returned untouched", () => {
  assert.deepEqual(splitComments("just words"), { prose: "just words", comments: [] });
  const open = "talk about octo-comments\n```octo-comments\napi/a.ts:1\n> x\nnote";
  assert.deepEqual(splitComments(open), { prose: open, comments: [] });
});

test("prose around the block is kept; two blocks both parse", () => {
  const a = formatComments([c({ text: "first" })]);
  const b = formatComments([c({ path: "z.ts", text: "second" })]);
  const { prose, comments } = splitComments(`before\n\n${a}\n\nbetween\n\n${b}\n\nafter`);
  assert.deepEqual(
    comments.map((x) => x.text),
    ["first", "second"],
  );
  assert.ok(prose.startsWith("before") && prose.includes("between") && prose.endsWith("after"));
});

test("an empty message and a block with no entries do not throw", () => {
  assert.deepEqual(splitComments(""), { prose: "", comments: [] });
  assert.deepEqual(splitComments("```octo-comments\n\n```"), { prose: "", comments: [] });
});

const roundTrip = (comments: ReturnType<typeof c>[]) => splitComments(formatComments(comments)).comments;

test("a comment whose text has a blank line then something shaped like a header stays one comment", () => {
  const { comments } = splitComments(formatComments([c({ text: "compare with\n\nsrc/other.ts:3" })]));
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.text, "compare with\n\nsrc/other.ts:3");
});

test("everything prepare() can emit parses back to what was sent (hostile text included)", () => {
  const texts = [
    "plain",
    "two\n\nparagraphs",
    "compare with\n\nsrc/other.ts:3",
    "src/other.ts:3 first line looks like a header",
    "x/y:3-9\n\nx/y:4",
    "a\n\n\n\nweb/src/a.ts:12-14\n> not a quote\nz/z:1",
    "> starts like a quote",
    ">",
    "> \u2026",
    "\u200bzero-width first",
    "ok\n\n\u200bsrc/a.ts:1",
    "ok\n\n\u200b\u200bsrc/a.ts:1",
    "```js\ncode\n```\n\nsrc/b.ts:2",
    "````\nfour ticks\n````",
    "trailing colon: a/b:",
    "a/b:3 \n\nc/d:4 ",
    "line with CRLF\r\n\r\nsrc/c.ts:7",
    "日本語/ファイル:12\n\n日本語/ファイル:13",
  ];
  for (const text of texts) {
    for (const lines of [[], ["only"], ["a", "", "b"], ["x/y:3", "> nested", ""], Array.from({ length: 9 }, (_, i) => `l${i}`)]) {
      const sent = [c({ text, lines, start: 5, end: 5 + Math.max(lines.length - 1, 0) }), c({ path: "z.ts", text: "next" })];
      const got = roundTrip(sent);
      assert.equal(got.length, 2, `two comments for ${JSON.stringify(text)} / ${lines.length} lines`);
      assert.equal(got[0]?.text, text.trim(), JSON.stringify(text));
      assert.equal(got[0]?.path, "src/auth/refresh.ts");
      assert.equal(got[1]?.text, "next");
      assert.equal(got[1]?.path, "z.ts");
      assert.deepEqual(
        got[0]?.quote,
        lines.slice(0, 6).map((l) => l.trimEnd()),
        "quote untouched",
      );
    }
  }
});

test("text that needs no escape is written exactly the way it was before the escape existed", () => {
  assert.ok(!formatComments([c({ text: "ordinary words\n\nsecond paragraph: see line 3" })]).includes("\u200b"));
  assert.ok(!formatComments([c({ text: "a/b is a path but not a header" })]).includes("\u200b"));
});

test("blocks written before the escape existed still parse", () => {
  const old = ["```octo-comments", "api/src/a.ts:3", "> let x = 1;", "Why?", "", "More.", "", "web/b.ts:9-10", "> y", "> z", "Second", "```"].join("\n");
  const { comments } = splitComments(old);
  assert.deepEqual(
    comments.map((x) => [x.folder, x.path, x.start, x.end, x.text]),
    [
      ["api", "src/a.ts", 3, 3, "Why?\n\nMore."],
      ["web", "b.ts", 9, 10, "Second"],
    ],
  );
});

test("requestTitle: prose first, else a summary of the comments, else the text", () => {
  // The count is joined to its noun by a no-break space so the summary never wraps between them.
  const title = (text: string) => requestTitle(text).replace(/\u00a0/g, " ");
  assert.equal(title("Fix the bug"), "Fix the bug");
  assert.equal(title(withComments("Fix it", formatComments([c()]))), "Fix it");
  assert.equal(title(formatComments([c()])), "1 comment on refresh.ts");
  assert.equal(title(formatComments([c(), c({ start: 1, end: 1 })])), "2 comments on refresh.ts");
  assert.equal(title(formatComments([c(), c(), c({ path: "b.ts" })])), "3 comments on refresh.ts and 1 other file");
  assert.equal(title(formatComments([c(), c({ path: "b.ts" }), c({ folder: "web" })])), "3 comments on refresh.ts and 2 other files");
  assert.equal(title(""), "");
  assert.ok(requestTitle(formatComments([c()])).startsWith("1\u00a0comment"));
});

test("linesLabel", () => {
  assert.equal(linesLabel(12, 12), "line 12");
  assert.equal(linesLabel(12, 14), "lines 12–14");
});
