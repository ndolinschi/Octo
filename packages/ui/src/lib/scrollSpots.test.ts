import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SPOTS, parseSpots, withSpot } from "./scrollSpots";

test("parseSpots keeps valid spots and drops everything else", () => {
  assert.deepEqual(parseSpots(undefined), {});
  assert.deepEqual(parseSpots([1, 2]), {});
  assert.deepEqual(parseSpots({ a: { top: 120, atBottom: false }, b: { top: "x", atBottom: false }, c: 4, d: { top: -5, atBottom: false } }), {
    a: { top: 120, atBottom: false },
    d: { top: 0, atBottom: false },
  });
});

test("withSpot sets a spot, and removes it when the reader is at the bottom", () => {
  const one = withSpot({}, "s1", { top: 300.4, atBottom: false });
  assert.deepEqual(one, { s1: { top: 300, atBottom: false } });
  assert.deepEqual(withSpot(one, "s1", { top: 900, atBottom: true }), {});
});

test("withSpot keeps the newest MAX_SPOTS entries, and an updated key becomes the newest", () => {
  let spots = {};
  for (let i = 0; i < MAX_SPOTS + 5; i++) spots = withSpot(spots, `s${i}`, { top: i + 1, atBottom: false });
  const keys = Object.keys(spots);
  assert.equal(keys.length, MAX_SPOTS);
  assert.equal(keys[0], "s5");
  const bumped = withSpot(spots, "s5", { top: 1, atBottom: false });
  assert.equal(Object.keys(bumped).at(-1), "s5");
});
