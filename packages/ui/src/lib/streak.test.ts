import assert from "node:assert/strict";
import test from "node:test";
import { parseColor, renderStreak } from "./streak";

const base = { cell: 2, overhang: 12, anchor: { x: 0.5, y: 0.3 }, panel: [23, 23, 23] as const, accent: [92, 157, 255] as const, indigo: [111, 108, 242] as const, warm: [216, 176, 122] as const, rimPeak: 0.3 };

test("never brighter than the peak, and dithered (more than two values in the band)", () => {
  const cols = 300, rows = 200;
  const out = new Uint32Array(cols * rows);
  const peak = renderStreak(out, { ...base, cols, rows, peak: 0.55 });
  assert.ok(peak <= 0.55 && peak > 0.4, String(peak));
  assert.ok(new Set(out).size > 8);
  const light = renderStreak(new Uint32Array(cols * rows), { ...base, cols, rows, peak: 0.22 });
  assert.ok(light <= 0.22);
});

test("deterministic", () => {
  const a = new Uint32Array(100 * 80);
  const b = new Uint32Array(100 * 80);
  renderStreak(a, { ...base, cols: 100, rows: 80, peak: 0.55 });
  renderStreak(b, { ...base, cols: 100, rows: 80, peak: 0.55 });
  assert.deepEqual(a, b);
});

test("colour parsing", () => {
  assert.deepEqual(parseColor("#5c9dff"), [92, 157, 255]);
  assert.deepEqual(parseColor(" rgb(1, 2, 3)"), [1, 2, 3]);
  assert.deepEqual(parseColor("nonsense"), [0, 0, 0]);
});
