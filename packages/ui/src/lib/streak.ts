/**
 * The dithered light streak, third pass (decision 32), as a pure function over a pixel buffer so it can be measured and
 * tested without a browser. Three layers in one pass, one sample per cell:
 * - a **hot core**: a line 2–4 cells wide at near-white (`#fff4e0`; dark 95%, light its own preset) along the band's
 *   axis, with a slow waviness so it never reads as a ruled line;
 * - a **glow** that falls off from the core with a long exponential tail, coloured by the distance from the core, not
 *   by the position along it: the warm side (below) runs amber → orange → red → magenta over a short tail, the cool side
 *   (above) runs pale gold → cyan → blue → indigo over a long one — the temperature contrast of the references;
 * - **grain everywhere**: the strength is quantised with interleaved-gradient (blue-noise-like) thresholds — no
 *   Bayer cross-hatch, so no staircase on the edges — every lit cell gets a small chromatic jitter, and a static field
 *   of faint coloured specks covers the whole background.
 * The cell size comes from the window width (2 CSS px up to 1600, 3 above).
 */

import type { StreakAnchor } from "./streakPresets";

export type { StreakAnchor };

export type Rgb = readonly [number, number, number];

export type StreakTheme = "dark" | "light";

export type StreakOptions = {
  cols: number;
  rows: number;
  /** CSS px per cell. */
  cell: number;
  /** CSS px the buffer overhangs the host on every side (room for the drift). */
  overhang: number;
  anchor: StreakAnchor;
  /** Steepness: the line climbs `rise` × height over the width (default 1, the host's diagonal). */
  rise?: number;
  /** Kept for the presets' shape; the third pass has no echo band. */
  echo?: number;
  panel: Rgb;
  accent: Rgb;
  theme: StreakTheme;
  /** Quantisation levels of the strength (default 5). */
  levels?: number;
  /** Share of background cells that carry a speck (default 0.35). */
  noise?: number;
};

/** A theme's look: core colour and alpha, glow peak alpha, the two sides' colour stops, the tails (× shorter side). */
export type StreakLook = {
  core: Rgb;
  coreAlpha: number;
  glowAlpha: number;
  warm: readonly Rgb[];
  cool: readonly Rgb[];
  warmTail: number;
  coolTail: number;
  /** Background specks: peak alpha. */
  speck: number;
  /** The glow's alpha follows exp(−u)^gamma: below 1 the colour stays strong longer, then drops (a lit edge, not a haze). */
  gamma: number;
};

/** Decision 32: near-white core at 95% over a dark panel; warm short tail below, cool long tail above. */
const DARK: StreakLook = {
  core: [0xff, 0xf4, 0xe0],
  coreAlpha: 0.95,
  glowAlpha: 0.9,
  warm: [
    [0xff, 0xc4, 0x5a],
    [0xff, 0x6a, 0x1a],
    [0xff, 0x2a, 0x12],
    [0xd8, 0x14, 0x4a],
    [0x6a, 0x10, 0x5a],
  ],
  cool: [
    [0xf6, 0xf0, 0xc8],
    [0x7c, 0xc8, 0xff],
    [0x2a, 0x78, 0xff],
    [0x22, 0x3c, 0xe0],
    [0x1a, 0x18, 0x7a],
  ],
  warmTail: 0.05,
  coolTail: 0.08,
  speck: 0.18,
  gamma: 0.7,
};

/**
 * Light has its own preset (a near-white core vanishes on white): the core is a deep red-orange line, the glow keeps
 * saturated, darker hues at a high alpha over short tails so the band reads as colour, not pastel mush.
 */
const LIGHT: StreakLook = {
  core: [0xe8, 0x2a, 0x08],
  coreAlpha: 0.95,
  glowAlpha: 0.9,
  warm: [
    [0xff, 0x4a, 0x10],
    [0xf0, 0x1e, 0x4a],
    [0xc0, 0x1a, 0x9a],
    [0x7a, 0x2a, 0xe0],
    [0x9a, 0x8a, 0xff],
  ],
  cool: [
    [0xff, 0x9a, 0x1a],
    [0xff, 0xc0, 0x2a],
    [0x1e, 0x9a, 0xff],
    [0x24, 0x4a, 0xf0],
    [0x7a, 0x7a, 0xff],
  ],
  warmTail: 0.026,
  coolTail: 0.05,
  speck: 0.12,
  gamma: 0.45,
};

export const STREAK_LOOK: Record<StreakTheme, StreakLook> = { dark: DARK, light: LIGHT };

/** Core half-width in cells (a 2–4 cell line) and the glow's cut-off (exp(−3.9) ≈ 2%; the sparse grain beyond it is the speck field). */
const CORE_CELLS = 1.15;
const CUTOFF = 3.9;
/** The axis's slow waviness: amplitude (× shorter side) and waves along the band. */
const WAVE = { amp: 0.006, freq: 1.6, phase: 0.7 } as const;
/** The colour runs through its stops over this many tails (faster than the light fades: saturated near the core). */
const COLOR_TAILS = 2.6;

const pack = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** A colour along `stops` at `t` ∈ [0, 1], linear between evenly spaced stops. */
export function sideColor(stops: readonly Rgb[], t: number): [number, number, number] {
  const x = (t < 0 ? 0 : t > 1 ? 1 : t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i] ?? [0, 0, 0];
  const b = stops[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Interleaved gradient noise (Jimenez 2014): a blue-noise-like threshold in [0, 1) per cell, with no grid pattern. */
export function ign(x: number, y: number): number {
  const v = 52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1);
  return v - Math.floor(v);
}

/** A cheap integer hash of a cell (the specks are static: the same on every draw). */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The strength `a` on one of `levels` steps (threshold ∈ [0, 1) from the dither), never above 1. */
export function quantize(a: number, levels: number, threshold: number): number {
  const q = Math.floor(a * levels + threshold) / levels;
  return q > 1 ? 1 : q;
}

/** The background tile: the panel with faint coloured specks (static, tiled under the band). */
const TILE = 128;
let tileCache: { key: string; tile: Uint32Array } | null = null;
function speckTile(panel: Rgb, look: StreakLook, share: number): Uint32Array {
  const key = `${panel.join(",")}:${look.speck}:${share}:${look.warm.length}`;
  if (tileCache?.key === key) return tileCache.tile;
  const tile = new Uint32Array(TILE * TILE).fill(pack(panel[0], panel[1], panel[2]));
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const h = hash(x, y);
      if ((h & 1023) / 1024 >= share) continue;
      // Mostly very faint, a few brighter (cubic): grain, not confetti.
      const n = ((h >>> 10) & 255) / 255;
      const a = look.speck * n * n * n + 0.015;
      const stops = (h >>> 18) & 1 ? look.warm : look.cool;
      const [r, g, b] = sideColor(stops, ((h >>> 19) & 255) / 255);
      tile[y * TILE + x] = pack(clamp255(panel[0] + (r - panel[0]) * a), clamp255(panel[1] + (g - panel[1]) * a), clamp255(panel[2] + (b - panel[2]) * a));
    }
  tileCache = { key, tile };
  return tile;
}

/** Per-cell dither thresholds (interleaved gradient noise) and chromatic jitter, as 128×128 tiles (computed once). */
let noiseTiles: { th: Float32Array; variant: Uint8Array } | null = null;
function noise(): NonNullable<typeof noiseTiles> {
  if (noiseTiles) return noiseTiles;
  const n = TILE * TILE;
  const t = { th: new Float32Array(n), variant: new Uint8Array(n) };
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const i = y * TILE + x;
      t.th[i] = ign(x, y);
      t.variant[i] = hash(x + 9173, y + 331) % VARIANTS.length;
    }
  noiseTiles = t;
  return t;
}

/** The packed colour table of the last draw (a redraw at the same band size reuses it). */
let colorCache: { key: string; colors: Uint32Array } | null = null;

/** The grain's chroma shifts (per channel, −1…1): a cell takes one of these, scaled by its strength. */
const VARIANTS: readonly Rgb[] = [
  [0, 0, 0],
  [1, -0.4, -0.6],
  [-0.6, 1, -0.3],
  [-0.5, -0.3, 1],
  [0.8, 0.6, -0.9],
  [-0.9, 0.5, 0.7],
  [0.6, -0.8, 0.6],
  [-0.4, -0.4, -0.4],
];

/** Steps of the per-distance tables (1 CSS px each). */
type SideTables = { glow: Float32Array; r: Float32Array; g: Float32Array; b: Float32Array };
function sideTables(stops: readonly Rgb[], tail: number, span: number, gamma: number): SideTables {
  const t: SideTables = { glow: new Float32Array(span), r: new Float32Array(span), g: new Float32Array(span), b: new Float32Array(span) };
  for (let i = 0; i < span; i++) {
    const u = i / tail;
    t.glow[i] = Math.exp(-u * gamma);
    const [r, g, b] = sideColor(stops, u / COLOR_TAILS);
    t.r[i] = r;
    t.g[i] = g;
    t.b[i] = b;
  }
  return t;
}

/** Fills `out` (RGBA as little-endian uint32, `cols × rows`) and returns the brightest strength drawn (0–1). */
export function renderStreak(out: Uint32Array, o: StreakOptions): number {
  const { cols, rows, cell, overhang, panel, theme } = o;
  const look = STREAK_LOOK[theme];
  const levels = o.levels ?? 5;
  const w = cols * cell - 2 * overhang;
  const h = rows * cell - 2 * overhang;
  const short = Math.max(1, Math.min(w, h));
  const ax = o.anchor.x * w;
  const ay = o.anchor.y * h;
  const angle = Math.atan2(h * (o.rise ?? 1), w);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const length = Math.hypot(w, h);

  // Background: the speck tile — its first 128 rows written once, the rest copied (the tile repeats every 128 rows).
  const tile = speckTile(panel, look, o.noise ?? 0.35);
  for (let y = 0; y < Math.min(rows, TILE); y++) {
    const ty = y * TILE;
    for (let x = 0; x < cols; x += TILE) out.set(tile.subarray(ty, ty + Math.min(TILE, cols - x)), y * cols + x);
  }
  for (let y = TILE; y < rows; y += TILE) out.copyWithin(y * cols, 0, Math.min(TILE, rows - y) * cols);

  const warmTail = look.warmTail * short;
  const coolTail = look.coolTail * short;
  const wSpan = Math.ceil((warmTail * CUTOFF) / look.gamma) + 2;
  const cSpan = Math.ceil((coolTail * CUTOFF) / look.gamma) + 2;
  // One table over the signed distance d (1 CSS px steps, index d + cSpan): glow, colour and the core's weight with
  // the core colour already mixed in, so a cell costs a handful of lookups.
  const warm = sideTables(look.warm, warmTail, wSpan, look.gamma);
  const cool = sideTables(look.cool, coolTail, cSpan, look.gamma);
  const coreW = Math.max(CORE_CELLS * cell, 0.0018 * short);
  const { coreAlpha, glowAlpha } = look;
  const [kr, kg, kb] = look.core;
  const span = cSpan + wSpan + 1;
  const tA = new Float32Array(span);
  const tR = new Float32Array(span);
  const tG = new Float32Array(span);
  const tB = new Float32Array(span);
  for (let k = 0; k < span; k++) {
    const d = k - cSpan;
    const side = d >= 0 ? warm : cool;
    const i = d < 0 ? -d : d;
    const glow = side.glow[i] ?? 0;
    const core = Math.exp(-((d / coreW) ** 2));
    tA[k] = glow * glowAlpha + core * (coreAlpha - glowAlpha * glow);
    const r = side.r[i] ?? 0;
    const g = side.g[i] ?? 0;
    const b = side.b[i] ?? 0;
    tR[k] = r + (kr - r) * core;
    tG[k] = g + (kg - g) * core;
    tB[k] = b + (kb - b) * core;
  }
  const waveAmp = WAVE.amp * short;
  // The waviness over s (1 CSS px steps), so the loop does no trigonometry.
  const sReach = Math.ceil(length) + 2 * overhang + 4;
  const wave = new Float32Array(2 * sReach + 1);
  for (let i = 0; i < wave.length; i++) wave[i] = waveAmp * Math.sin(((i - sReach) * Math.PI * 2 * WAVE.freq) / length + WAVE.phase);
  const wLast = wave.length - 1;
  const { th: thTile, variant } = noise();
  const reachUp = cSpan + waveAmp + cell;
  const reachDown = wSpan + waveAmp + cell;

  // Every colour a cell can take, packed: per chroma variant (the grain's per-cell colour shift), distance and level.
  // A cell then costs its distance, one threshold and one read.
  const [pr, pg, pb] = panel;
  const jitter = theme === "dark" ? 40 : 30;
  const L1 = levels + 1;
  const colorKey = `${theme}:${panel.join(",")}:${span}:${cSpan}:${coreW}:${levels}:${short}`;
  const fresh = colorCache?.key !== colorKey;
  const colors = fresh ? new Uint32Array(VARIANTS.length * span * L1) : (colorCache?.colors ?? new Uint32Array(0));
  for (let v = 0; fresh && v < VARIANTS.length; v++) {
    const [jr, jg, jb] = VARIANTS[v] ?? [0, 0, 0];
    for (let k = 0; k < span; k++)
      for (let q = 1; q <= levels; q++) {
        const aq = q / levels;
        const j = jitter * aq;
        const r = pr + ((tR[k] as number) + jr * j - pr) * aq;
        const g = pg + ((tG[k] as number) + jg * j - pg) * aq;
        const b = pb + ((tB[k] as number) + jb * j - pb) * aq;
        colors[(v * span + k) * L1 + q] = pack(clamp255(r), clamp255(g), clamp255(b));
      }
  }
  if (fresh) colorCache = { key: colorKey, colors };
  let brightest = 0;
  for (let k = 0; k < span; k++) if ((tA[k] as number) > brightest) brightest = tA[k] as number;

  const half = cell / 2 - overhang;
  const dStep = -cell * sin;
  const sStep = cell * cos;
  for (let y = 0; y < rows; y++) {
    const py = y * cell + half - ay;
    const rowBase = y * cols;
    const tRow = (y & (TILE - 1)) * TILE;
    // d = −px·sin + py·cos is linear in x: only cells within the band's reach on either side are visited.
    const xFrom = Math.max(0, Math.floor(((py * cos - reachDown) / sin + ax - half) / cell) - 1);
    const xTo = Math.min(cols, Math.ceil(((py * cos + reachUp) / sin + ax - half) / cell) + 2);
    const px0 = xFrom * cell + half - ax;
    let dLin = -px0 * sin + py * cos + cSpan + 0.5;
    let sIdx = px0 * cos + py * sin + sReach + 0.5;
    for (let x = xFrom; x < xTo; x++, dLin += dStep, sIdx += sStep) {
      let si = sIdx | 0;
      si = si < 0 ? 0 : si > wLast ? wLast : si;
      // k: the signed distance from the (wavy) axis, d > 0 below it (the warm side).
      const k = (dLin - (wave[si] as number)) | 0;
      if (k < 0 || k >= span) continue;
      // Blue-noise-like quantisation: grain at every level (only the thin core reaches the top step).
      const ti = tRow + (x & (TILE - 1));
      let q = ((tA[k] as number) * levels + (thTile[ti] as number)) | 0;
      if (q <= 0) continue;
      if (q > levels) q = levels;
      out[rowBase + x] = colors[((variant[ti] as number) * span + k) * L1 + q] as number;
    }
  }
  return brightest;
}

/** The dither cell in CSS px for the *window* width (decision 32: 2 up to 1600 wide, 3 above). */
export function streakCell(windowWidth: number): number {
  return windowWidth > 1600 ? 3 : 2;
}

/** "#rrggbb" or "rgb(r g b)" / "rgb(r, g, b)" → RGB; anything else is black. */
export function parseColor(value: string): Rgb {
  const v = value.trim();
  const hex = /^#([\da-f]{6})$/i.exec(v);
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(v);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [0, 0, 0];
}
