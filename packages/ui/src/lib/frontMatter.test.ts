import assert from "node:assert/strict";
import test from "node:test";
import { splitFrontMatter } from "./frontMatter";

test("front matter is split off, fields read, quotes dropped", () => {
  const r = splitFrontMatter('---\ntitle: "Getting started"\nsidebar:\n  order: 1\n---\n# Hello\n');
  assert.deepEqual(r?.fields, [
    ["title", "Getting started"],
    ["sidebar", "order: 1"],
  ]);
  assert.equal(r?.body, "# Hello\n");
});

test("no front matter: null (a rule later in the file is not front matter)", () => {
  assert.equal(splitFrontMatter("# Title\n\n---\n\ntext"), null);
  assert.equal(splitFrontMatter("---\nnot closed"), null);
});

test("CRLF and a closing '...' work", () => {
  assert.equal(splitFrontMatter("---\r\na: 1\r\n...\r\nbody")?.body, "body");
});
