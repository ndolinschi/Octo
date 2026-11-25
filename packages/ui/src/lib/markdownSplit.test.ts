import assert from "node:assert/strict";
import test from "node:test";
import { splitStableMarkdown } from "./markdownSplit";

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
