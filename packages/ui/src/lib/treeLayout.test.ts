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

test("an undragged column (stored 0) takes 40% of the view, 220 to 360, and leaves the editor its 360", () => {
  assert.deepEqual(treeLayout(760, 0, 200), { page: false, column: 304, maxWidth: 400 });
  assert.equal(treeLayout(634, 0, 200).column, 254);
  assert.equal(treeLayout(1400, 0, 200).column, 360, "at most 360");
  assert.equal(treeLayout(590, 0, 200).column, 230, "the 220 floor gives way to the editor's 360");
  assert.equal(treeLayout(570, 0, 200).column, 210);
  assert.equal(treeLayout(570, 0, 200).page, false);
  assert.equal(treeLayout(550, 0, 200).page, true, "under 200 + 360 it is a page, as before");
  assert.equal(treeLayout(0, 0, 200).column, 220, "unmeasured: the floor");
});
