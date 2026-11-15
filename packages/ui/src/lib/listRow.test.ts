import assert from "node:assert/strict";
import test from "node:test";
import { emptyNode, nodeText, rowHeight, selectionAria } from "./listRow";

test("one-line rows are 28, 32 or 40 and grow to 40 on touch", () => {
  assert.equal(rowHeight("sm", false), "h-ctl-sm touch:h-ctl-lg");
  assert.equal(rowHeight("md", false), "h-ctl-md touch:h-ctl-lg");
  assert.equal(rowHeight("lg", false), "h-ctl-lg");
});

test("a two-line row has a minimum height, whatever the size", () => {
  assert.equal(rowHeight("sm", true), "min-h-ctl-lg");
  assert.equal(rowHeight("lg", true), rowHeight("md", true));
});

test("selection is aria-selected for options and tree items, aria-current for plain rows", () => {
  assert.deepEqual(selectionAria("option", true), { "aria-selected": "true" });
  assert.deepEqual(selectionAria("option", false), { "aria-selected": "false" });
  assert.deepEqual(selectionAria(undefined, true), { "aria-current": "true" });
  assert.deepEqual(selectionAria(undefined, false), {});
  assert.deepEqual(selectionAria("menuitemradio", true), { "aria-checked": "true" });
});

test("nodeText: the text of a meta node, through wrapper elements; nothing for a node with no text", () => {
  assert.equal(nodeText("50m"), "50m");
  assert.equal(nodeText(3), "3");
  assert.equal(nodeText({ props: { "aria-hidden": true, children: "2 running" } }), "2 running");
  assert.equal(nodeText({ props: { children: ["Ctrl", "+K"] } }), "Ctrl+K");
  assert.equal(nodeText({ props: { className: "dot" } }), "");
  assert.equal(nodeText(null), "");
  assert.equal(nodeText(false), "");
});

test("emptyNode: a missing meta, or a wrapper with nothing in it, draws nothing; a dot draws", () => {
  assert.equal(emptyNode(undefined), true);
  assert.equal(emptyNode(""), true);
  assert.equal(emptyNode({ props: { "aria-hidden": true, children: null } }), true);
  assert.equal(emptyNode({ props: { children: [null, false] } }), true);
  assert.equal(emptyNode({ props: { children: "1h" } }), false);
  assert.equal(emptyNode({ props: { className: "dot" } }), false);
  assert.equal(emptyNode(0), false);
});
