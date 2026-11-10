import assert from "node:assert/strict";
import test from "node:test";
import { formatSeparator, needsSeparator } from "./format";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

test("separator after a 30-minute pause or a new day, and before the first request", () => {
  assert.equal(needsSeparator(null, at(2026, 11, 10, 9)), true);
  assert.equal(needsSeparator(at(2026, 11, 10, 9), at(2026, 11, 10, 9, 20)), false);
  assert.equal(needsSeparator(at(2026, 11, 10, 9), at(2026, 11, 10, 9, 31)), true);
  assert.equal(needsSeparator(at(2026, 11, 9, 23, 50), at(2026, 11, 10, 0, 5)), true);
});

test("Today / Yesterday / date, locale time", () => {
  const now = Date.parse(at(2026, 11, 10, 15));
  assert.match(formatSeparator(at(2026, 11, 10, 10), now, "en-GB"), /^Today 10:00$/);
  assert.match(formatSeparator(at(2026, 11, 9, 18, 42), now, "en-GB"), /^Yesterday 18:42$/);
  assert.match(formatSeparator(at(2026, 11, 6, 9, 15), now, "en-GB"), /^6 Nov, 0?9:15$/);
  assert.match(formatSeparator(at(2025, 11, 6, 9, 15), now, "en-GB"), /2025/);
});
