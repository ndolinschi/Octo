/**
 * The dithered light streak's pixels (contract v6 decision 21), as a pure function over a pixel buffer so it
 * can be measured and tested without a browser. One band at 24° (down to the right) through `anchor`, made of
 * four soft lobes along it (accent → indigo), a thin warm rim on its lower edge, quantised to a few alpha
 * levels with a 4×4 Bayer ordered dither, one value per cell.
 */

/** 4×4 Bayer matrix (0–15), row-major. */
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/** Where the band's centre line passes, as fractions of the host's width and height. */
export type StreakAnchor = { x: number; y: number };

export type Rgb = readonly [number, number, number];

export type StreakOptions = {
  cols: number;
  rows: number;
  /** CSS px per cell. */
  cell: number;
  /** CSS px the buffer overhangs the host on every side (room for the drift). */
  overhang: number;
  anchor: StreakAnchor;
  panel: Rgb;
  accent: Rgb;
  indigo: Rgb;
  warm: Rgb;
  /** Peak alpha of the band's core (dark ≤ 0.55, light ≤ 0.22). */
  peak: number;
  rimPeak: number;
  levels?: number;
};

const ANGLE = (24 * Math.PI) / 180;
/** Lobes along the band: centre (fraction of width from the anchor), along-spread (fraction), offset and spread across (px), amplitude. */
const LOBES = [
  { s: -0.42, ss: 0.2, d: -12, sd: 46, a: 0.5 },
  { s: -0.08, ss: 0.17, d: 0, sd: 40, a: 1 },
  { s: 0.26, ss: 0.19, d: 10, sd: 52, a: 0.78 },
  { s: 0.58, ss: 0.24, d: 18, sd: 72, a: 0.42 },
] as const;
const RIM = { d: 64, sd: 7 };

const pack = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** Fills `out` (RGBA as little-endian uint32, `cols × rows`) and returns the brightest core alpha drawn. */
export function renderStreak(out: Uint32Array, o: StreakOptions): number {
  const { cols, rows, cell, overhang, panel, accent, indigo, warm } = o;
  const levels = o.levels ?? 6;
  const width = cols * cell - 2 * overhang;
  const ax = o.anchor.x * width;
  const ay = o.anchor.y * (rows * cell - 2 * overhang);
  const cos = Math.cos(ANGLE);
  const sin = Math.sin(ANGLE);
  out.fill(pack(panel[0], panel[1], panel[2]));

  // Lookup tables at 1 CSS px: lobe profiles along (s) and across (d) the band, so a cell costs lookups only.
  const reach = Math.ceil(Math.hypot(cols * cell, rows * cell)) + 2;
  const sTab = LOBES.map((l) => {
    const t = new Float32Array(2 * reach + 1);
    const c = l.s * width;
    const sp = l.ss * width;
    for (let i = 0; i < t.length; i++) t[i] = l.a * Math.exp(-((i - reach - c) ** 2) / (2 * sp * sp));
    return t;
  });
  const dMax = 200;
  const dTab = LOBES.map((l) => {
    const t = new Float32Array(2 * dMax + 1);
    for (let i = 0; i < t.length; i++) t[i] = Math.exp(-((i - dMax - l.d) ** 2) / (2 * l.sd * l.sd));
    return t;
  });
  const rimTab = new Float32Array(2 * dMax + 1);
  for (let i = 0; i < rimTab.length; i++) rimTab[i] = Math.exp(-((i - dMax - RIM.d) ** 2) / (2 * RIM.sd * RIM.sd));

  // mix = 0.35 + (s − reach) / (1.6·width) + (d − dMax) / 260, folded into constants.
  const mixS = 1 / (1.6 * width);
  const mixD = 1 / 260;
  const mix0 = 0.35 - reach * mixS - dMax * mixD;
  // Four lobes, unrolled (the hot loop stays monomorphic).
  const [s0, s1, s2, s3] = sTab as [Float32Array, Float32Array, Float32Array, Float32Array];
  const [d0, d1, d2, d3] = dTab as [Float32Array, Float32Array, Float32Array, Float32Array];
  let brightest = 0;
  for (let y = 0; y < rows; y++) {
    const py = y * cell + cell / 2 - overhang - ay;
    // d = -(px)·sin + py·cos is linear in x: only cells within ±dMax of the centre line are computed.
    const xFrom = Math.max(0, Math.floor(((py * cos - dMax) / sin + ax + overhang) / cell));
    const xTo = Math.min(cols, Math.ceil(((py * cos + dMax) / sin + ax + overhang) / cell));
    // s and d move linearly along a row: step them instead of recomputing (the hot loop is lookups only).
    const px0 = xFrom * cell + cell / 2 - overhang - ax;
    let s = px0 * cos + py * sin + reach + 0.5;
    let d = -px0 * sin + py * cos + dMax + 0.5;
    const ds = cell * cos;
    const dd = cell * sin;
    const rowBase = y * cols;
    const bRow = (y & 3) * 4;
    for (let x = xFrom; x < xTo; x++, s += ds, d -= dd) {
      const si = s | 0;
      const di = d | 0;
      if (di < 0 || di > 2 * dMax || si < 0 || si > 2 * reach) continue;
      const a0 = s0[si] as number;
      const a1 = s1[si] as number;
      const a2 = s2[si] as number;
      const a3 = s3[si] as number;
      let core = a0 * (d0[di] as number) + a1 * (d1[di] as number) + a2 * (d2[di] as number) + a3 * (d3[di] as number);
      const along = a0 + a1 + a2 + a3;
      if (core < 0.002 && along < 0.002) continue;
      if (core > 1) core = 1;
      const rim = (along > 1 ? 1 : along) * (rimTab[di] as number);
      const threshold = (BAYER4[bRow + (x & 3)] as number) / 16;
      // Ordered dither, never above the peak (decision 21: dark ≤ 55%, light ≤ 22%).
      const a = Math.min(o.peak, Math.floor(core * o.peak * levels + threshold) / levels);
      const ra = Math.min(o.rimPeak, Math.floor(rim * o.rimPeak * levels + threshold) / levels);
      if (a <= 0 && ra <= 0) continue;
      if (a > brightest) brightest = a;
      // Accent along the upper side and the left, indigo toward the lower right.
      const mixed = mix0 + s * mixS + d * mixD;
      const mix = mixed < 0 ? 0 : mixed > 1 ? 1 : mixed;
      let r = panel[0] + (accent[0] + (indigo[0] - accent[0]) * mix - panel[0]) * a;
      let g = panel[1] + (accent[1] + (indigo[1] - accent[1]) * mix - panel[1]) * a;
      let b = panel[2] + (accent[2] + (indigo[2] - accent[2]) * mix - panel[2]) * a;
      r += (warm[0] - r) * ra;
      g += (warm[1] - g) * ra;
      b += (warm[2] - b) * ra;
      out[rowBase + x] = pack(r | 0, g | 0, b | 0);
    }
  }
  return brightest;
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
