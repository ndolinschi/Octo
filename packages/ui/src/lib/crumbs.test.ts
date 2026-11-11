import assert from "node:assert/strict";
import test from "node:test";
import { crumbName, fitCrumbs, type CrumbWidths } from "./crumbs";

// folder 80, dirs 60/50/70, file 120 (chrome 30), sep 14, gaps 2 → separators cost 18 each.
const w: CrumbWidths = { folder: 80, dirs: [60, 50, 70], file: 120, fileChrome: 30, sep: 14, ellipsis: 20, gap: 2 };
const full = 80 + 60 + 50 + 70 + 120 + 4 * 18;

test("everything shows when it fits", () => {
  assert.deepEqual(fitCrumbs(w, full), { folder: true, dirs: [0, 1, 2], hidden: [], nameChars: null });
});

test("then folder › … › parent › file", () => {
  const plan = fitCrumbs(w, full - 1);
  assert.deepEqual(plan, { folder: true, dirs: [2], hidden: [0, 1], nameChars: null });
});

test("then … › parent › file (the folder joins the hidden crumbs), then … › file", () => {
  assert.deepEqual(fitCrumbs(w, 20 + 70 + 120 + 2 * 18), { folder: false, dirs: [2], hidden: [-1, 0, 1], nameChars: null });
  assert.deepEqual(fitCrumbs(w, 20 + 120 + 18), { folder: false, dirs: [], hidden: [-1, 0, 1, 2], nameChars: null });
});

test("a file alone that does not fit is shortened once, in the middle", () => {
  const plan = fitCrumbs(w, 100);
  assert.equal(plan.dirs.length, 0);
  assert.ok(plan.nameChars !== null && plan.nameChars >= 6);
  const name = crumbName("getting-started-with-the-harness.md", plan);
  assert.equal((name.match(/…/g) ?? []).length, 1);
  assert.ok(name.endsWith(".md"));
});

test("a file at the folder root: folder › file, else … › file", () => {
  const root: CrumbWidths = { ...w, dirs: [] };
  assert.deepEqual(fitCrumbs(root, 80 + 120 + 18), { folder: true, dirs: [], hidden: [], nameChars: null });
  assert.deepEqual(fitCrumbs(root, 80 + 120 + 17).hidden, [-1]);
});
