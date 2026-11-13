import assert from "node:assert/strict";
import test from "node:test";
import { ign, monoLook, parseColor, quantize, renderStreak, sideColor, STREAK_LOOK, streakCell, type StreakOptions } from "./streak";

const dark: Omit<StreakOptions, "cols" | "rows"> = {
  cell: 2,
  overhang: 12,
  anchor: { x: 0.5, y: 0.4 },
  panel: [23, 23, 23],
  accent: [92, 157, 255],
  theme: "dark",
};
const light: Omit<StreakOptions, "cols" | "rows"> = { ...dark, panel: [255, 255, 255], accent: [10, 102, 224], theme: "light" };

const ch = (px: number, i: 0 | 1 | 2) => (px >>> (i * 8)) & 255;

function render(o: Omit<StreakOptions, "cols" | "rows">, cols = 500, rows = 360) {
  const out = new Uint32Array(cols * rows);
  const peak = renderStreak(out, { ...o, cols, rows });
  return { out, cols, rows, peak };
}

test("side colours run through their stops by distance", () => {
  const stops = STREAK_LOOK.dark.warm;
  assert.deepEqual(sideColor(stops, 0), [...(stops[0] ?? [])]);
  assert.deepEqual(sideColor(stops, 1), [...(stops[stops.length - 1] ?? [])]);
  const mid = sideColor(
    [
      [0, 0, 0],
      [200, 100, 50],
    ],
    0.5,
  );
  assert.deepEqual(mid, [100, 50, 25]);
});

test("the hot core is a thin near-white line (2–4 cells across), at its peak", () => {
  const { out, cols, rows, peak } = render(dark);
  assert.ok(peak > 0.9 && peak <= STREAK_LOOK.dark.coreAlpha + 1e-6, String(peak));
  // Walk down column x: count the near-white cells (all channels high) — the core's width in cells.
  const x = Math.floor(cols / 2);
  let white = 0;
  for (let y = 0; y < rows; y++) {
    const px = out[y * cols + x] ?? 0;
    if (ch(px, 0) > 225 && ch(px, 1) > 205 && ch(px, 2) > 170) white += 1;
  }
  assert.ok(white >= 2 && white <= 6, `core ${white} cells`);
});

test("temperature contrast: warm (red > blue) below the core, cool (blue > red) above it", () => {
  const { out, cols, rows } = render(dark);
  const x = Math.floor(cols / 2);
  // The axis at x = cols/2 runs through the anchor (0.4 of the height) on the diagonal.
  const yc = Math.round(rows * 0.4);
  const avg = (y0: number, y1: number) => {
    const s = [0, 0, 0];
    for (let y = y0; y < y1; y++) for (let i = 0; i < 3; i++) s[i] = (s[i] ?? 0) + ch(out[y * cols + x] ?? 0, i as 0 | 1 | 2);
    return s.map((v) => v / (y1 - y0));
  };
  const below = avg(yc + 4, yc + 14);
  const above = avg(yc - 30, yc - 6);
  assert.ok((below[0] ?? 0) > (below[2] ?? 0) + 40, `below ${below.join(",")}`);
  assert.ok((above[2] ?? 0) > (above[0] ?? 0) + 20, `above ${above.join(",")}`);
});

test("grain everywhere: about a third of background cells carry a faint speck", () => {
  const { out } = render({ ...dark, anchor: { x: 0.5, y: 40 }, rise: 0 }); // band far below: background only
  const base = ((255 << 24) | (23 << 16) | (23 << 8) | 23) >>> 0;
  const lit = [...out].filter((px) => px !== base);
  const share = lit.length / out.length;
  assert.ok(share > 0.25 && share < 0.45, String(share));
  assert.ok(
    lit.every((px) => Math.max(ch(px, 0), ch(px, 1), ch(px, 2)) < 23 + 0.25 * 255),
    "specks stay faint",
  );
});

test("no staircase: across a mid-strength stretch neighbouring levels interleave (blue-noise thresholds)", () => {
  // Quantising a smooth ramp with the per-cell thresholds: where the strength sits between two steps, both appear.
  const levels = 5;
  const a = 0.5; // between 2/5 and 3/5
  let hi = 0;
  const n = 64 * 64;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (quantize(a, levels, ign(x, y)) > 0.45) hi += 1;
  assert.ok(hi / n > 0.35 && hi / n < 0.65, String(hi / n));
  // The thresholds are spread evenly over [0, 1).
  const bins = [0, 0, 0, 0];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) bins[Math.floor(ign(x, y) * 4)] = (bins[Math.floor(ign(x, y) * 4)] ?? 0) + 1;
  for (const b of bins) assert.ok(b > n * 0.2 && b < n * 0.3, bins.join(","));
});

test("light has its own preset: the band darkens the white panel with saturated colour, never pastel mush", () => {
  const { out, peak } = render(light);
  assert.ok(peak > 0.85, String(peak));
  // Some cells strongly saturated (a channel spread over 120) and clearly darker than white.
  const vivid = [...out].filter((px) => Math.max(ch(px, 0), ch(px, 1), ch(px, 2)) - Math.min(ch(px, 0), ch(px, 1), ch(px, 2)) > 120);
  assert.ok(vivid.length > 500, String(vivid.length));
});

test("deterministic, and within budget for a 1440×900 Home at 2px cells", () => {
  const cols = Math.ceil((1100 + 24) / 2);
  const rows = Math.ceil((860 + 24) / 2);
  const a = new Uint32Array(cols * rows);
  const b = new Uint32Array(cols * rows);
  renderStreak(a, { ...dark, cols, rows });
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    renderStreak(b, { ...dark, cols, rows });
    times.push(performance.now() - t0);
  }
  assert.deepEqual(a, b);
  times.sort((x, y) => x - y);
  assert.ok((times[2] ?? 0) < 20, `${(times[2] ?? 0).toFixed(1)}ms (Node; the browser figure is in the spec)`);
});

test("cell size from the window width, and colour parsing", () => {
  assert.equal(streakCell(1440), 2);
  assert.equal(streakCell(1600), 2);
  assert.equal(streakCell(1601), 3);
  assert.equal(streakCell(1920), 3);
  assert.deepEqual(parseColor("#5c9dff"), [92, 157, 255]);
  assert.deepEqual(parseColor(" rgb(1, 2, 3)"), [1, 2, 3]);
  assert.equal(parseColor("nonsense"), null, "unreadable: no colour (never black)");
  assert.equal(parseColor(""), null);
  assert.deepEqual(parseColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseColor("rgb(255 255 255)"), [255, 255, 255]);
  assert.deepEqual(parseColor("color(srgb 1 1 1)"), [255, 255, 255]);
});

test("monoLook keeps the band in the accent hue at 35%", () => {
  const look = monoLook([92, 157, 255], "dark");
  assert.equal(look.coreAlpha, 0.35);
  assert.equal(look.glowAlpha, 0.35);
  assert.ok([...look.warm, ...look.cool].every((c) => c.join() === "92,157,255"));
});

test("a mono render uses only the accent hue over the panel", () => {
  const cols = 60;
  const rows = 40;
  const out = new Uint32Array(cols * rows);
  renderStreak(out, { cols, rows, cell: 3, overhang: 0, anchor: { x: 0.5, y: 0.5 }, panel: [23, 23, 23], accent: [92, 157, 255], theme: "dark", mono: true });
  for (const px of out) {
    const r = px & 255;
    const b = (px >>> 16) & 255;
    // Every pixel lies between the panel and the accent: blue never falls below red.
    assert.ok(b >= r, `pixel ${px.toString(16)}`);
  }
});
