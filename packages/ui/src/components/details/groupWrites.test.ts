import { must } from "../../lib/must";
import assert from "node:assert/strict";
import test from "node:test";
import type { WrittenFile } from "../../lib/toolsMore";
import { groupWrites } from "./useWrittenFiles";

const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).toISOString();
const w = (path: string, when: string, folder = "api"): WrittenFile => ({ folder, path, at: when, agentId: "a" });
const now = new Date(2026, 10, 10, 15).getTime();

test("writes fall into Today, This week and Earlier, in that order, omitting empty groups", () => {
  const groups = groupWrites([w("old.ts", at(2026, 10, 1)), w("now.ts", at(2026, 11, 10, 9)), w("week.ts", at(2026, 11, 7))], now);
  assert.deepEqual(
    groups.map((g) => [g.label, g.files.map((f) => f.path)]),
    [
      ["Today", ["now.ts"]],
      ["This week", ["week.ts"]],
      ["Earlier", ["old.ts"]],
    ],
  );
  assert.deepEqual(
    groupWrites([w("a.ts", at(2026, 11, 10, 8))], now).map((g) => g.label),
    ["Today"],
  );
  assert.deepEqual(groupWrites([], now), []);
});

test("the week reaches back six days from the start of today", () => {
  assert.deepEqual(
    groupWrites([w("a.ts", at(2026, 11, 4, 12))], now).map((g) => g.label),
    ["This week"],
  );
  assert.deepEqual(
    groupWrites([w("a.ts", at(2026, 11, 3, 12))], now).map((g) => g.label),
    ["Earlier"],
  );
});

test("one row per folder and path with a write count, newest first; the same path in another folder is its own row", () => {
  const groups = groupWrites(
    [w("a.ts", at(2026, 11, 10, 8)), w("b.ts", at(2026, 11, 10, 10)), w("a.ts", at(2026, 11, 10, 11)), w("a.ts", at(2026, 11, 10, 7), "web")],
    now,
  );
  const files = must(groups[0]).files;
  assert.deepEqual(
    files.map((f) => [f.folder, f.path, f.count]),
    [
      ["api", "a.ts", 2],
      ["api", "b.ts", 1],
      ["web", "a.ts", 1],
    ],
  );
  assert.equal(must(files[0]).at, at(2026, 11, 10, 11), "the row carries the latest write time");
});

test("input order does not matter and the input is not mutated", () => {
  const input = [w("a.ts", at(2026, 11, 10, 8)), w("b.ts", at(2026, 11, 10, 9))];
  const copy = [...input];
  groupWrites(input, now);
  assert.deepEqual(input, copy);
  assert.deepEqual(groupWrites([...input].reverse(), now), groupWrites(input, now));
});
