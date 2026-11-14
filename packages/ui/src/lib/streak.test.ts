import assert from "node:assert/strict";
import test from "node:test";
import { envelope, ign, monoLook, parseColor, renderStreak, sideColor, STREAK_LOOK, streakCell, type StreakOptions } from "./streak";

const dark: Omit<StreakOptions, "cols" | "rows"> = {
  cell: 0.5,
  overhang: 12,
  anchor: { x: 0.5, y: 0.5 },
  rise: 0.5,
  panel: [23, 23, 23],
  accent: [92, 157, 255],
  theme: "dark",
};
const light: Omit<StreakOptions, "cols" | "rows"> = { ...dark, panel: [255, 255, 255], accent: [10, 102, 224], theme: "light" };

const ch = (px: number, i: 0 | 1 | 2) => (px >>> (i * 8)) & 255;
const panelPx = (p: readonly number[]) => ((255 << 24) | ((p[2] ?? 0) << 16) | ((p[1] ?? 0) << 8) | (p[0] ?? 0)) >>> 0;

/** A Home-sized band (1100 × 126 CSS px) at 2× unless told otherwise. */
function render(o: Omit<StreakOptions, "cols" | "rows">, width = 1100, height = 126) {
  const cols = Math.ceil((width + 2 * o.overhang) / o.cell);
  const rows = Math.ceil((height + 2 * o.overhang) / o.cell);
  const out = new Uint32Array(cols * rows);
  const peak = renderStreak(out, { ...o, cols, rows });
  return { out, cols, rows, peak };
}

/** The column of buffer pixels at CSS x (from the host's left edge). */
const colAt = (o: Omit<StreakOptions, "cols" | "rows">, cssX: number) => Math.floor((cssX + o.overhang) / o.cell);

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

test("the envelope is full in the middle, eases out and is zero at both ends", () => {
  assert.equal(envelope(0), 1);
  assert.equal(envelope(-0.1), 1);
  assert.equal(envelope(1), 0);
  assert.equal(envelope(-1), 0);
  let prev = 1;
  for (let t = 0; t <= 1; t += 0.02) {
    const e = envelope(t);
    assert.ok(e <= prev + 1e-9, `monotonic at ${t}`);
    assert.equal(e, envelope(-t), "symmetric");
    prev = e;
  }
});

test("dark: a soft near-white core in the middle, about 2 CSS px across", () => {
  const { out, cols, rows, peak } = render(dark);
  assert.ok(peak > 0.8 && peak <= STREAK_LOOK.dark.coreAlpha + 1e-6, String(peak));
  const x = colAt(dark, 550);
  let white = 0;
  for (let y = 0; y < rows; y++) {
    const px = out[y * cols + x] ?? 0;
    if (ch(px, 0) > 200 && ch(px, 1) > 190 && ch(px, 2) > 170) white += 1;
  }
  // Buffer pixels are half a CSS px: 2–8 of them is a 1–4 CSS px line.
  assert.ok(white >= 2 && white <= 8, `core ${white} px`);
});

test("temperature contrast: warm (red > blue) below the core, cool (blue > red) above it", () => {
  const { out, cols } = render(dark);
  const x = colAt(dark, 550);
  // At the anchor's x the axis is at the band's middle (63 CSS px), give or take the waviness.
  const yAt = (cssY: number) => Math.floor((cssY + dark.overhang) / dark.cell);
  const avg = (y0: number, y1: number) => {
    const s = [0, 0, 0];
    for (let y = yAt(y0); y < yAt(y1); y++) for (let i = 0; i < 3; i++) s[i] = (s[i] ?? 0) + ch(out[y * cols + x] ?? 0, i as 0 | 1 | 2);
    return s.map((v) => v / (yAt(y1) - yAt(y0)));
  };
  const below = avg(63 + 8, 63 + 14);
  const above = avg(63 - 24, 63 - 10);
  assert.ok((below[0] ?? 0) > (below[2] ?? 0) + 15, `below ${below.join(",")}`);
  assert.ok((above[2] ?? 0) > (above[0] ?? 0) + 8, `above ${above.join(",")}`);
});

test("quiet: no speck field — away from the band every pixel is exactly the panel", () => {
  const { out, cols, rows } = render(dark);
  const base = panelPx(dark.panel);
  // The far ends (outside the envelope) and the corners away from the line.
  for (let y = 0; y < rows; y++) {
    for (const x of [0, 1, 2, cols - 3, cols - 2, cols - 1]) assert.equal(out[y * cols + x], base, `end pixel ${x},${y}`);
  }
  const far = render({ ...dark, anchor: { x: 0.5, y: 40 }, rise: 0 });
  assert.ok(
    [...far.out].every((px) => px === base),
    "band far below: background only",
  );
});

test("smooth: neighbouring pixels along a column change by small steps (no dither grain, no hard edges)", () => {
  const { out, cols, rows } = render(dark);
  for (const cssX of [300, 550, 800]) {
    const x = colAt(dark, cssX);
    let jumps = 0;
    for (let y = 1; y < rows; y++) {
      const a = out[(y - 1) * cols + x] ?? 0;
      const b = out[y * cols + x] ?? 0;
      const step = Math.max(...([0, 1, 2] as const).map((i) => Math.abs(ch(a, i) - ch(b, i))));
      // The core is a soft line: half-CSS-px steps across it can be large; elsewhere small.
      if (step > 24) jumps += 1;
    }
    assert.ok(jumps <= 8, `column ${cssX}: ${jumps} large steps`);
  }
});

test("the streak fades toward both ends: the middle is brighter than near the edges", () => {
  const { out, cols, rows } = render(dark);
  const strength = (cssX: number) => {
    const x = colAt(dark, cssX);
    let max = 0;
    for (let y = 0; y < rows; y++) max = Math.max(max, ch(out[y * cols + x] ?? 0, 0) - 23);
    return max;
  };
  const mid = strength(550);
  assert.ok(strength(120) < mid * 0.5, `left ${strength(120)} vs ${mid}`);
  assert.ok(strength(980) < mid * 0.5, `right ${strength(980)} vs ${mid}`);
  assert.equal(strength(20), 0, "nothing at the very edge");
});

test("light: the band tints the white panel softly — never darker than mid-grey, saturation kept low", () => {
  const { out, peak } = render(light);
  assert.ok(peak > 0.6, String(peak));
  let spreadMax = 0;
  let minLuma = 255;
  for (const px of out) {
    const r = ch(px, 0);
    const g = ch(px, 1);
    const b = ch(px, 2);
    spreadMax = Math.max(spreadMax, Math.max(r, g, b) - Math.min(r, g, b));
    minLuma = Math.min(minLuma, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  // The previous pass had cells with a channel spread over 200 (saturated red on white); the quiet one stays under 100.
  assert.ok(spreadMax < 100, `spread ${spreadMax}`);
  assert.ok(minLuma > 128, `darkest ${minLuma}`);
});

test("deterministic, and within budget for a 1440×900 Home band at 2×", () => {
  const cols = Math.ceil((1170 + 24) / 0.5);
  const rows = Math.ceil((126 + 24) / 0.5);
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
  assert.ok((times[2] ?? 0) < 60, `${(times[2] ?? 0).toFixed(1)}ms (Node; drawn once per size)`);
});

test("one buffer pixel per device pixel, capped at 2×; colour parsing", () => {
  assert.equal(streakCell(1), 1);
  assert.equal(streakCell(2), 0.5);
  assert.equal(streakCell(3), 0.5);
  assert.equal(streakCell(1.25), 1);
  assert.equal(streakCell(0), 1);
  assert.deepEqual(parseColor("#5c9dff"), [92, 157, 255]);
  assert.deepEqual(parseColor(" rgb(1, 2, 3)"), [1, 2, 3]);
  assert.equal(parseColor("nonsense"), null, "unreadable: no colour (never black)");
  assert.equal(parseColor(""), null);
  assert.deepEqual(parseColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseColor("rgb(255 255 255)"), [255, 255, 255]);
  assert.deepEqual(parseColor("color(srgb 1 1 1)"), [255, 255, 255]);
});

test("the anti-banding dither is a small value spread evenly over [0, 1)", () => {
  const bins = [0, 0, 0, 0];
  const n = 64 * 64;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) bins[Math.floor(ign(x, y) * 4)] = (bins[Math.floor(ign(x, y) * 4)] ?? 0) + 1;
  for (const b of bins) assert.ok(b > n * 0.2 && b < n * 0.3, bins.join(","));
  // With the grain off, a render has no pixel off the smooth ramp: rendering twice with grain 0 and 1 differs by ≤ 1 level.
  const a = render({ ...dark, grain: 0 }, 300, 80);
  const b = render({ ...dark, grain: 1 }, 300, 80);
  for (let i = 0; i < a.out.length; i++)
    for (const c of [0, 1, 2] as const) assert.ok(Math.abs(ch(a.out[i] ?? 0, c) - ch(b.out[i] ?? 0, c)) <= 1, `pixel ${i}`);
});

test("monoLook keeps the band in the accent hue at a low peak", () => {
  const look = monoLook([92, 157, 255], "dark");
  assert.equal(look.coreAlpha, 0.3);
  assert.ok(look.glowAlpha < look.coreAlpha);
  assert.ok([...look.warm, ...look.cool].every((c) => c.join() === "92,157,255"));
});

test("a mono render uses only the accent hue over the panel", () => {
  const { out } = render({ ...dark, mono: true, grain: 0 }, 300, 80);
  for (const px of out) {
    const r = px & 255;
    const b = (px >>> 16) & 255;
    // Every pixel lies between the panel and the accent: blue never falls below red.
    assert.ok(b >= r, `pixel ${px.toString(16)}`);
  }
});
