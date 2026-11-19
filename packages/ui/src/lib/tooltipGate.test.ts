import assert from "node:assert/strict";
import test from "node:test";
import { tipMayShow } from "./tooltipGate";

test("a pointer-armed tooltip shows only while its control is under the pointer", () => {
  assert.equal(tipMayShow({ armed: true, connected: true, byPointer: true, hovered: true }), true);
  assert.equal(tipMayShow({ armed: true, connected: true, byPointer: true, hovered: false }), false);
});

test("a tooltip never shows for a control that left the page or was disarmed", () => {
  assert.equal(tipMayShow({ armed: true, connected: false, byPointer: false, hovered: false }), false);
  assert.equal(tipMayShow({ armed: false, connected: true, byPointer: true, hovered: true }), false);
});

test("a focus-armed tooltip needs no hover", () => {
  assert.equal(tipMayShow({ armed: true, connected: true, byPointer: false, hovered: false }), true);
});
