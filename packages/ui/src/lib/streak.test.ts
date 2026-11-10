import assert from "node:assert/strict";
import test from "node:test";
import { bandAlpha, parseColor, quantizeAlpha, rampColor, renderStreak, STREAK_ALPHA, streakCell, type StreakOptions } from "./streak";

const dark: Omit<StreakOptions, "cols" | "rows"> = {
  cell: 3,
  overhang: 12,
  anchor: { x: 0.5, y: 0.4 },
  panel: [23, 23, 23],
  accent: [92, 157, 255],
  theme: "dark",
};
const light: Omit<StreakOptions, "cols" | "rows"> = { ...dark, panel: [255, 255, 255], accent: [10, 102, 224], theme: "light" };

const channel = (px: number, i: 0 | 1 | 2) => (px >>> (i * 8)) & 255;

test("alpha ramp: halo peak at the halo, core peak at the core, per theme", () => {
  assert.equal(bandAlpha(0, "dark"), 0);
  assert.ok(Math.abs(bandAlpha(0.55, "dark") - STREAK_ALPHA.dark.halo) < 1e-9);
  assert.ok(Math.abs(bandAlpha(1, "dark") - STREAK_ALPHA.dark.core) < 1e-9);
  assert.ok(Math.abs(bandAlpha(1, "light") - 0.55) < 1e-9);
  assert.ok(bandAlpha(2, "dark") <= 0.95);
});

test("colour ramp runs falloff → accent → violet → pink → amber", () => {
  assert.deepEqual(rampColor(0, [92, 157, 255], "dark"), [0x1b, 0x2a, 0x5e]);
  assert.deepEqual(rampColor(0.3, [92, 157, 255], "dark"), [92, 157, 255]);
  assert.deepEqual(rampColor(1, [92, 157, 255], "dark"), [0xff, 0x7a, 0x3d]);
  assert.deepEqual(rampColor(0, [10, 102, 224], "light"), [0xdf, 0xe8, 0xff]);
  const mid = rampColor(0.68, [92, 157, 255], "dark");
  assert.ok(mid[0] > 0x7a && mid[0] < 0xff, "between violet and pink");
});

test("the band is bold: the core reaches its peak, and it crosses the panel corner to corner", () => {
  const cols = 400;
  const rows = 260;
  const out = new Uint32Array(cols * rows);
  const peak = renderStreak(out, { ...dark, cols, rows });
  assert.ok(peak > 0.85 && peak <= STREAK_ALPHA.dark.core, String(peak));
  // Lit cells near the top-left and near the bottom-right corners (the diagonal through the anchor).
  const lit = (x0: number, y0: number) => {
    let n = 0;
    for (let y = y0; y < y0 + 20; y++) for (let x = x0; x < x0 + 20; x++) if (channel(out[y * cols + x] ?? 0, 2) > 60) n++;
    return n;
  };
  assert.ok(lit(10, 10) > 20, "top-left");
  assert.ok(lit(cols - 40, rows - 40) > 20, "bottom-right");
  // Hot colours exist (red channel well above blue) somewhere in the core.
  assert.ok([...out].some((px) => channel(px, 0) > 200 && channel(px, 2) < 120));
});

test("quantised: the band's strength takes 5 levels, and the dither mixes neighbours, never above the peak", () => {
  const seen = new Set<number>();
  for (let a = 0; a <= 0.95; a += 0.01) for (let t = 0; t < 16; t++) seen.add(Math.round(quantizeAlpha(a, 0.95, 5, (t + 0.5) / 16) * 1000));
  assert.deepEqual(
    [...seen].sort((x, y) => x - y),
    [0, 238, 475, 712, 950],
  );
  // Halfway between two steps, about half the thresholds land on each.
  const mid = Array.from({ length: 16 }, (_, t) => quantizeAlpha(0.95 * 0.375, 0.95, 5, (t + 0.5) / 16));
  assert.equal(new Set(mid).size, 2);
});

test("sparse noise outside the band, about 3% of cells, faint", () => {
  const cols = 300;
  const rows = 200;
  const out = new Uint32Array(cols * rows);
  renderStreak(out, { ...dark, cols, rows, anchor: { x: 5, y: 5 } }); // band far outside: only noise
  const base = out[0];
  const lit = [...out].filter((px) => px !== ((255 << 24) | (23 << 16) | (23 << 8) | 23) >>> 0);
  const share = lit.length / out.length;
  assert.ok(share > 0.02 && share < 0.04, String(share));
  assert.ok(
    lit.every((px) => channel(px, 2) < 23 + 0.1 * 255 + 1),
    "at most 10% alpha",
  );
  void base;
});

test("light theme darkens the white panel (never brighter), core ≤ 55%", () => {
  const cols = 300;
  const rows = 200;
  const out = new Uint32Array(cols * rows);
  const peak = renderStreak(out, { ...light, cols, rows });
  assert.ok(peak <= 0.55);
  assert.ok([...out].some((px) => channel(px, 2) < 200));
});

test("deterministic, and fast enough for 1440×900 at 3px cells", () => {
  const cols = Math.ceil((1440 + 24) / 3);
  const rows = Math.ceil((900 + 24) / 3);
  const a = new Uint32Array(cols * rows);
  const b = new Uint32Array(cols * rows);
  renderStreak(a, { ...dark, cols, rows });
  const t0 = performance.now();
  renderStreak(b, { ...dark, cols, rows });
  const ms = performance.now() - t0;
  assert.deepEqual(a, b);
  assert.ok(ms < 40, `${ms.toFixed(1)}ms (Node, unwarmed; the browser figure is in the spec)`);
});

test("cell size and colour parsing", () => {
  assert.equal(streakCell(1440), 3);
  assert.equal(streakCell(1920), 4);
  assert.deepEqual(parseColor("#5c9dff"), [92, 157, 255]);
  assert.deepEqual(parseColor(" rgb(1, 2, 3)"), [1, 2, 3]);
  assert.deepEqual(parseColor("nonsense"), [0, 0, 0]);
});
