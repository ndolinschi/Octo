import assert from "node:assert/strict";
import test from "node:test";
import { revealOnTap, REVEAL_MS } from "./tapReveal";

test("a plain tap toggles the revealed action", () => {
  assert.equal(revealOnTap(false, false), true);
});

test("a tap on a control inside, or a text selection, keeps its own meaning", () => {
  assert.equal(revealOnTap(true, false), false);
  assert.equal(revealOnTap(false, true), false);
});

test("the action hides again after a few seconds", () => {
  assert.equal(REVEAL_MS, 5000);
});
