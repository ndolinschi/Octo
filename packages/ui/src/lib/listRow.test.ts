import assert from "node:assert/strict";
import test from "node:test";
import { rowHeight, selectionAria } from "./listRow";

test("one-line rows are 28, 32 or 40 and grow to 40 on touch", () => {
  assert.equal(rowHeight("sm", false), "h-ctl-sm touch:h-ctl-lg");
  assert.equal(rowHeight("md", false), "h-ctl-md touch:h-ctl-lg");
  assert.equal(rowHeight("lg", false), "h-ctl-lg");
});

test("a two-line row has a minimum height, whatever the size", () => {
  assert.equal(rowHeight("sm", true), "min-h-ctl-lg py-1");
  assert.equal(rowHeight("lg", true), rowHeight("md", true));
});

test("selection is aria-selected for options and tree items, aria-current for plain rows", () => {
  assert.deepEqual(selectionAria("option", true), { "aria-selected": "true" });
  assert.deepEqual(selectionAria("option", false), { "aria-selected": "false" });
  assert.deepEqual(selectionAria(undefined, true), { "aria-current": "true" });
  assert.deepEqual(selectionAria(undefined, false), {});
  assert.deepEqual(selectionAria("menuitemradio", true), { "aria-checked": "true" });
});
