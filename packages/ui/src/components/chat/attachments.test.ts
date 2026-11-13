import assert from "node:assert/strict";
import test from "node:test";
import { isTextFile, refusal, sizeLabel, withAttachments } from "./attachments";

test("text files are recognised by type or name", () => {
  assert.equal(isTextFile("a.ts", ""), true);
  assert.equal(isTextFile("Dockerfile", ""), true);
  assert.equal(isTextFile("notes", "text/plain"), true);
  assert.equal(isTextFile("photo.png", "image/png"), false);
});

test("refusals name the file and a way forward", () => {
  assert.match(refusal("photo.png", "image/png", 10) ?? "", /image/);
  assert.match(refusal("big.log", "", 300 * 1024) ?? "", /256 KB/);
  assert.equal(refusal("a.ts", "", 10), null);
});

test("attachments go after the text as fenced blocks that outlast any fence inside", () => {
  assert.equal(withAttachments("Hi", []), "Hi");
  const out = withAttachments("Look", [{ id: "1", name: "a.md", size: 1, text: "x\n```\ny\n```\n" }]);
  assert.equal(out, "Look\n\nAttached file `a.md`:\n\n````markdown\nx\n```\ny\n```\n````");
  assert.equal(withAttachments("", [{ id: "1", name: "b.txt", size: 1, text: "z" }]), "Attached file `b.txt`:\n\n```\nz\n```");
});

test("sizeLabel", () => {
  assert.equal(sizeLabel(812), "812 B");
  assert.equal(sizeLabel(4100), "4 KB");
  assert.equal(sizeLabel(1_300_000), "1.2 MB");
});
