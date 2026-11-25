import assert from "node:assert/strict";
import test from "node:test";
import { isRowMenuKey } from "./listStops";

test("Shift+F10 and the context-menu key open a row's menu; F10 alone does not", () => {
  assert.equal(isRowMenuKey({ key: "F10", shiftKey: true }), true);
  assert.equal(isRowMenuKey({ key: "ContextMenu", shiftKey: false }), true);
  assert.equal(isRowMenuKey({ key: "F10", shiftKey: false }), false);
  assert.equal(isRowMenuKey({ key: "Enter", shiftKey: true }), false);
});
