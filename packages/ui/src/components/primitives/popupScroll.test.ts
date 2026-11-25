import assert from "node:assert/strict";
import test from "node:test";
import { closesOnScroll, movedFar, overscrolled, SLOP } from "./popupScroll";

const at = (x: number, y: number) => ({ x, y });

test("movedFar: within the slop is still, beyond it is moved, in either axis", () => {
  assert.equal(movedFar(at(10, 10), at(10, 10)), false);
  assert.equal(movedFar(at(10, 10), at(10, 10 + SLOP)), false);
  assert.equal(movedFar(at(10, 10), at(10, 10 + SLOP + 0.5)), true);
  assert.equal(movedFar(at(10, 10), at(7, 10)), true);
});

test("closesOnScroll: a scroll inside the popup never closes, even with the anchor gone", () => {
  assert.equal(closesOnScroll({ inside: true, from: at(0, 0), now: at(0, 500) }), false);
  assert.equal(closesOnScroll({ inside: true, from: at(0, 0), now: null }), false);
});

test("closesOnScroll: outside, it closes only when the anchor moved", () => {
  assert.equal(closesOnScroll({ inside: false, from: at(5, 40), now: at(5, 40) }), false);
  assert.equal(closesOnScroll({ inside: false, from: at(5, 40), now: at(5, 40.8) }), false);
  assert.equal(closesOnScroll({ inside: false, from: at(5, 40), now: at(5, 12) }), true);
});

test("closesOnScroll: an anchor that left the page closes; no anchor at all closes on any outside scroll", () => {
  assert.equal(closesOnScroll({ inside: false, from: at(5, 40), now: null }), true);
  assert.equal(closesOnScroll({ inside: false, from: null, now: null }), true);
});

test("overscrolled: before the start or past the end is the elastic bounce, inside the range is not", () => {
  const max = at(0, 300);
  assert.equal(overscrolled(at(0, -12), max), true);
  assert.equal(overscrolled(at(-3, 0), max), true);
  assert.equal(overscrolled(at(0, 340), max), true);
  assert.equal(overscrolled(at(0, 0), max), false);
  assert.equal(overscrolled(at(0, 300), max), false);
  assert.equal(overscrolled(at(0, 150), max), false);
});
