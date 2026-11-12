import assert from "node:assert/strict";
import test from "node:test";
import { treeLayout } from "./treeLayout";

test("an unmeasured view is a column", () => {
  assert.equal(treeLayout(0, 220, 200).page, false);
});

test("the column needs the editor to keep 360", () => {
  assert.equal(treeLayout(580, 220, 200).page, false);
  assert.equal(treeLayout(579, 220, 200).page, true);
  assert.equal(treeLayout(390, 220, 200).page, true);
  assert.equal(treeLayout(636, 220, 200).page, false);
});

test("a narrow dock always uses the page", () => {
  assert.equal(treeLayout(1200, 220, 200, true).page, true);
});

test("the column keeps its stored width; dragging may take it up to what leaves the editor 360", () => {
  assert.deepEqual(treeLayout(1000, 220, 200), { page: false, column: 220, maxWidth: 640 });
  assert.equal(treeLayout(600, 300, 200).page, true, "300 + 360 > 600: a page, the column is not squeezed");
  assert.equal(treeLayout(300, 220, 200).maxWidth, 200, "never under the minimum");
});
