import assert from "node:assert/strict";
import test from "node:test";
import { costCellShort } from "./costCell";

test("costCellShort: spend, subscription equivalent, both, no price", () => {
  assert.equal(costCellShort({ spent: 1.2, equivalent: 0, estimated: false }), "$1.20");
  assert.equal(costCellShort({ spent: 0, equivalent: 9, estimated: false }), "≈ $9.00");
  assert.equal(costCellShort({ spent: 0.5, equivalent: 9, estimated: true }), "$0.50 + ≈ $9.00");
  assert.equal(costCellShort({ spent: null, equivalent: 0, estimated: false }), "no price");
  assert.equal(costCellShort({ spent: null, equivalent: 0.04, estimated: false }), "no price + ≈ $0.04");
});
