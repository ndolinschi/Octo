import assert from "node:assert/strict";
import test from "node:test";
import { isScrollKey, READER_INPUT_MS, stickDecision } from "./stickDecision";

const base = { end: false, following: true, movedUp: true, distance: 92, page: 740, sinceInput: Number.POSITIVE_INFINITY };

test("at the end the view follows", () => {
  assert.equal(stickDecision({ ...base, end: true }), "follow");
  assert.equal(stickDecision({ ...base, end: true, following: false }), "follow");
});

test("WebKit moving scrollTop up by itself (no input) puts a following view back at the end", () => {
  assert.equal(stickDecision(base), "repin");
  assert.equal(stickDecision({ ...base, distance: 391 }), "repin");
});

test("a reflow that leaves a following view short of the end repins", () => {
  assert.equal(stickDecision({ ...base, movedUp: false, distance: 0, sinceInput: 10 }), "repin");
});

test("the reader scrolling up right after their input lets go", () => {
  assert.equal(stickDecision({ ...base, sinceInput: 0 }), "let-go");
  assert.equal(stickDecision({ ...base, sinceInput: READER_INPUT_MS }), "let-go");
  assert.equal(stickDecision({ ...base, sinceInput: READER_INPUT_MS + 1 }), "repin");
});

test("a move of a screenful or more counts as the reader's even without input (assistive page scroll, find)", () => {
  assert.equal(stickDecision({ ...base, distance: 700 }), "let-go");
  assert.equal(stickDecision({ ...base, distance: 600 }), "repin");
});

test("a view that is not following stays let go", () => {
  assert.equal(stickDecision({ ...base, following: false }), "let-go");
  assert.equal(stickDecision({ ...base, following: false, movedUp: false }), "let-go");
});

test("scroll keys", () => {
  for (const k of ["PageUp", "Home", "ArrowUp", " "]) assert.ok(isScrollKey(k));
  for (const k of ["a", "Enter", "Escape"]) assert.ok(!isScrollKey(k));
});
