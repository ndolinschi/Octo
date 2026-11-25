import assert from "node:assert/strict";
import test from "node:test";
import { editorAriaLabel, ESCAPE_OUT_WHEN, isApple } from "./editorA11y";

test("the editor's name says the file and the platform's way out", () => {
  assert.equal(editorAriaLabel("src/a.ts", false), "Editor: src/a.ts. Press Ctrl+M, then Tab, to move focus out.");
  assert.equal(editorAriaLabel("src/a.ts", true), "Editor: src/a.ts. Press Ctrl+Shift+M, then Tab, to move focus out.");
  assert.equal(isApple("MacIntel"), true);
  assert.equal(isApple("iPhone"), true);
  assert.equal(isApple("Linux x86_64"), false);
});

test("Esc leaves only when no widget or selection would take it", () => {
  for (const k of ["editorTextFocus", "!editorHasSelection", "!suggestWidgetVisible", "!findWidgetVisible"]) assert.ok(ESCAPE_OUT_WHEN.includes(k), k);
});
