import assert from "node:assert/strict";
import test from "node:test";
import { splitMarkdownSections, splitStableMarkdown } from "./markdownSplit";

test("splitStableMarkdown keeps single-block text in tail", () => {
  assert.deepEqual(splitStableMarkdown("Hello world\nline two"), { stable: [], tail: "Hello world\nline two" });
});

test("splitStableMarkdown splits completed paragraphs while keeping 1:1 concatenation", () => {
  const input = "First paragraph.\n\nSecond paragraph.\n\nThird streaming";
  const { stable, tail } = splitStableMarkdown(input);
  assert.deepEqual(stable, ["First paragraph.\n\n", "Second paragraph.\n\n"]);
  assert.equal(tail, "Third streaming");
  assert.equal([...stable, tail].join(""), input);
});

test("splitStableMarkdown never splits inside an open fenced code block", () => {
  const input = "Intro paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
  const { stable, tail } = splitStableMarkdown(input);
  assert.deepEqual(stable, ["Intro paragraph.\n\n"]);
  assert.equal(tail, "```ts\nconst a = 1;\n\nconst b = 2;\n");
  assert.equal([...stable, tail].join(""), input);
});

test("splitStableMarkdown keeps multi-paragraph lists/blockquotes intact", () => {
  const input = "Intro\n\n- first item\n\n- second item\n\nAfter list";
  const { stable, tail } = splitStableMarkdown(input);
  assert.equal([...stable, tail].join(""), input);
  assert.ok(!stable.some((chunk) => chunk.endsWith("- first item\n\n") && tail.startsWith("- second item")));
});

test("splitMarkdownSections skips short docs and docs with reference link definitions", () => {
  assert.equal(splitMarkdownSections("Short doc.\n\nSecond paragraph."), null);
  const withRef = `${"Paragraph text. ".repeat(120)}\n\n## Section\n\nSee [docs][ref].\n\n[ref]: https://example.com\n`;
  assert.equal(splitMarkdownSections(withRef, 400), null);
});

test("splitMarkdownSections groups long documents at headings while preserving 1:1 text", () => {
  const para = "Long paragraph content for section testing. ".repeat(12);
  const input = `# Title\n\n${para}\n\n## Second\n\n${para}\n\n## Third\n\n${para}\n`;
  const sections = splitMarkdownSections(input, 400);
  assert.ok(sections && sections.length >= 2);
  assert.equal(sections.join(""), input);
  assert.ok(sections.slice(1).some((s) => s.startsWith("## ")));
});
