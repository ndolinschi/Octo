import assert from "node:assert/strict";
import test from "node:test";
import { estimateGrid, XTERM_SCROLLBAR } from "./grid";

test("estimateGrid divides the box minus the scrollbar by the cell, as the fit addon does", () => {
  assert.deepEqual(estimateGrid({ width: 800, height: 400, cellWidth: 7.8, cellHeight: 17, scrollbar: XTERM_SCROLLBAR }), { cols: 100, rows: 23 });
  assert.deepEqual(estimateGrid({ width: 20, height: 5, cellWidth: 8, cellHeight: 17, scrollbar: XTERM_SCROLLBAR }), { cols: 2, rows: 1 });
});

test("estimateGrid has no answer without a box or a cell", () => {
  assert.equal(estimateGrid({ width: 0, height: 400, cellWidth: 8, cellHeight: 17, scrollbar: 0 }), null);
  assert.equal(estimateGrid({ width: 800, height: 400, cellWidth: 0, cellHeight: 17, scrollbar: 0 }), null);
  assert.equal(estimateGrid({ width: 800, height: 400, cellWidth: Number.NaN, cellHeight: 17, scrollbar: 0 }), null);
});
