import assert from "node:assert/strict";
import test from "node:test";
import { treeLayout } from "./treeLayout";

test("an unmeasured view is not an overlay", () => {
  assert.equal(treeLayout(0, 280, 200).overlay, false);
});

test("a narrow view floats the tree; a wide one gives it a column", () => {
  assert.equal(treeLayout(500, 280, 200).overlay, true);
  assert.equal(treeLayout(636, 280, 200).overlay, true); // 636 - 254 < 480
  assert.equal(treeLayout(1000, 280, 200).overlay, false);
});

test("the maximum width keeps the editor or leaves room for the overlay", () => {
  assert.equal(treeLayout(500, 280, 200).maxWidth, 452);
  assert.equal(treeLayout(1000, 280, 200).maxWidth, 400);
});
