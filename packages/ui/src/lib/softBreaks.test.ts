import assert from "node:assert/strict";
import test from "node:test";
import { readsAsLines, softBreaks, type MdNode } from "./softBreaks";

const para = (...children: MdNode[]): MdNode => ({ type: "paragraph", children });
const text = (value: string): MdNode => ({ type: "text", value });
const root = (...children: MdNode[]): MdNode => ({ type: "root", children });

test("short lines read as lines; prose wrapped at a column does not", () => {
  assert.equal(readsAsLines(["apples", "bananas", "cherries"]), true);
  assert.equal(readsAsLines(["Name: Atlas API", "Owner: payments", "Region: eu-west-1"]), true);
  // Long lines that each end a sentence are lines too.
  assert.equal(readsAsLines(["The migration adds the settlement_lines table and its two indexes.", "The backfill runs tonight."]), true);
  // Hard-wrapped at 72: the line before the break stops mid-sentence.
  assert.equal(
    readsAsLines(["This change moves the token refresh into the service worker so that the", "tabs share one refresh and the race in session.ts goes away."]),
    false,
  );
  // One wrapped break is enough to keep the paragraph as prose.
  assert.equal(readsAsLines(["Summary:", "the refresh now happens once in the service worker for all of the open", "tabs."]), false);
});

test("a paragraph of lines gets break nodes; trailing and leading spaces at the breaks go", () => {
  const tree = root(para(text("one  \n  two\nthree")));
  softBreaks(tree);
  assert.deepEqual(tree, root(para(text("one"), { type: "break" }, text("two"), { type: "break" }, text("three"))));
});

test("breaks inside emphasis are split too; inline code is left alone", () => {
  const tree = root(para(text("- "), { type: "inlineCode", value: "a.ts" }, text("\n"), { type: "strong", children: [text("b\nc")] }));
  softBreaks(tree);
  assert.deepEqual(
    tree,
    root(para(text("- "), { type: "inlineCode", value: "a.ts" }, { type: "break" }, { type: "strong", children: [text("b"), { type: "break" }, text("c")] })),
  );
});

test("wrapped prose and single-line paragraphs are unchanged; nested paragraphs (lists, quotes) are reached", () => {
  const wrapped = "This change moves the token refresh into the service worker so that the\ntabs share one refresh.";
  const tree = root(para(text(wrapped)), para(text("single line")), { type: "listItem", children: [para(text("x\ny"))] });
  softBreaks(tree);
  assert.deepEqual(tree, root(para(text(wrapped)), para(text("single line")), { type: "listItem", children: [para(text("x"), { type: "break" }, text("y"))] }));
});
