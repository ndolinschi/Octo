/**
 * The light streak, quiet pass (owner's audit: "a different banner on Home instead of the noisy dithering"; decisions 32,
 * 91a), as a pure function over a pixel buffer so it can be measured and tested without a browser. One smooth pass,
 * one sample per device pixel:
 * - a **core**: a soft line about 2 CSS px wide (near-white in dark, a muted coral in light) along the band's axis, with a
 *   slow waviness so it never reads as a ruled line;
 * - a **glow** that falls off from the core exponentially, coloured by the distance from it: warm below (amber → coral →
 *   plum), cool above over a longer tail (pale gold → sky → indigo) — the temperature contrast of the earlier passes,
 *   at lower alpha and saturation;
 * - an **envelope** along the band: full strength over the middle, easing to nothing well before either end, the core
 *   tapering sooner than the glow — a streak of light, not a ruled line clipped by the panel's corners.
 * No quantisation and no speck field: the only grain is a ±1-level luminance dither on lit pixels, below what the eye
 * sees, which keeps the gradient free of banding. Pixels the band does not reach are exactly the panel colour.
 */

import type { StreakAnchor } from "./streakPresets";

export type { StreakAnchor };

export type Rgb = readonly [number, number, number];

export type StreakTheme = "dark" | "light";

export type StreakOptions = {
  cols: number;
  rows: number;
  /** CSS px per buffer pixel (1 / the drawing scale: 0.5 on a 2× screen). */
  cell: number;
  /** CSS px the buffer overhangs the host on every side. */
  overhang: number;
  anchor: StreakAnchor;
  /** Steepness: the line climbs `rise` × height over the width (default 1, the host's diagonal). */
  rise?: number;
  /** Kept for the presets' shape; the streak has no echo band. */
  echo?: number;
  panel: Rgb;
  accent: Rgb;
  theme: StreakTheme;
  /** Anti-banding dither in 8-bit levels on lit pixels (default 1; 0 turns it off). */
  grain?: number;
  /** Decision 31's Mono backdrop: the same band in the accent hue alone, at a low peak. */
  mono?: boolean;
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
  /** The glow's alpha follows exp(−u)^gamma: below 1 the colour holds longer, then drops. */
  gamma: number;
};

/** Dark: a near-white core at 85% over the panel; warm short tail below, cool long tail above, glow at 50%. */
const DARK: StreakLook = {
  core: [0xff, 0xf6, 0xe8],
  coreAlpha: 0.85,
  glowAlpha: 0.5,
  warm: [
    [0xff, 0xcc, 0x84],
    [0xff, 0x8e, 0x52],
    [0xe8, 0x56, 0x6c],
    [0x9a, 0x3a, 0x86],
    [0x3a, 0x26, 0x5e],
  ],
  cool: [
    [0xf4, 0xee, 0xd4],
    [0x9c, 0xcf, 0xff],
    [0x5a, 0x96, 0xff],
    [0x46, 0x56, 0xdc],
    [0x22, 0x20, 0x66],
  ],
  warmTail: 0.06,
  coolTail: 0.12,
  gamma: 0.8,
};

/**
 * Light: a near-white core vanishes on white, so the core is a muted coral line; the glow is soft and low in
 * saturation (owner: the red/blue line on white noise "looks like an artefact"), over slightly longer tails.
 */
const LIGHT: StreakLook = {
  core: [0xee, 0x8a, 0x6e],
  coreAlpha: 0.72,
  glowAlpha: 0.4,
  warm: [
    [0xff, 0xa8, 0x7c],
    [0xf2, 0x8c, 0xa4],
    [0xc4, 0x9c, 0xe4],
    [0xb4, 0xbc, 0xf2],
    [0xd8, 0xdc, 0xf6],
  ],
  cool: [
    [0xff, 0xc8, 0x8c],
    [0xff, 0xdc, 0xa8],
    [0x9c, 0xc6, 0xfa],
    [0xa8, 0xb2, 0xf4],
    [0xd6, 0xda, 0xf8],
  ],
  warmTail: 0.07,
  coolTail: 0.14,
  gamma: 0.9,
};

export const STREAK_LOOK: Record<StreakTheme, StreakLook> = { dark: DARK, light: LIGHT };

/** Decision 31 — Mono: the band's shape in one hue (`accent`), peak 30%: it reads as a tint, not light. */
export function monoLook(accent: Rgb, theme: StreakTheme): StreakLook {
  const base = STREAK_LOOK[theme];
  const ramp = [accent, accent, accent, accent, accent] as const;
  return { ...base, core: accent, coreAlpha: 0.3, glowAlpha: 0.22, warm: ramp, cool: ramp };
}

/** Core half-width (CSS px) and the glow's cut-off (exp(−4.6) ≈ 1%). */
const CORE_PX = 1.25;
const CUTOFF = 4.6;
/** The axis's slow waviness: amplitude (× shorter side) and waves along the band. */
const WAVE = { amp: 0.04, freq: 1.2, phase: 0.7 } as const;
/** The colour runs through its stops over this many tails (faster than the light fades: saturated near the core). */
const COLOR_TAILS = 2.6;
/**
 * The envelope along the band, over the horizontal offset from the anchor as a share of half the width: full strength
 * inside `plateau`, zero beyond `reach`, a smoothstep between. The core takes the envelope squared, so it tapers sooner.
 */
const ENVELOPE = { plateau: 0.12, reach: 0.94 } as const;

const pack = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);

/** A colour along `stops` at `t` ∈ [0, 1], linear between evenly spaced stops. */
export function sideColor(stops: readonly Rgb[], t: number): [number, number, number] {
  const x = (t < 0 ? 0 : t > 1 ? 1 : t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i] ?? [0, 0, 0];
  const b = stops[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** The envelope at a horizontal offset `t` (share of half the width, any sign): 1 in the middle, 0 at the ends. */
export function envelope(t: number): number {
  const a = t < 0 ? -t : t;
  if (a <= ENVELOPE.plateau) return 1;
  if (a >= ENVELOPE.reach) return 0;
  const u = 1 - (a - ENVELOPE.plateau) / (ENVELOPE.reach - ENVELOPE.plateau);
  return u * u * (3 - 2 * u);
}

/** Interleaved gradient noise (Jimenez 2014): a blue-noise-like value in [0, 1) per pixel, with no grid pattern. */
export function ign(x: number, y: number): number {
  const v = 52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1);
  return v - Math.floor(v);
}

let ditherCache: { grain: number; tile: Float32Array } | null = null;
/** 64 × 64 triangular dither values in −grain…grain (two interleaved-gradient samples summed), computed once. */
function ditherTile(grain: number): Float32Array {
  if (ditherCache?.grain === grain) return ditherCache.tile;
  const tile = new Float32Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) tile[(y << 6) | x] = (ign(x, y) + ign(x + 17, y + 31) - 1) * grain;
  ditherCache = { grain, tile };
  return tile;
}

/** Per-distance tables (one step per buffer pixel): glow strength and colour on one side of the core. */
type SideTables = { glow: Float32Array; r: Float32Array; g: Float32Array; b: Float32Array };
function sideTables(stops: readonly Rgb[], tail: number, span: number, step: number, gamma: number): SideTables {
  const t: SideTables = { glow: new Float32Array(span), r: new Float32Array(span), g: new Float32Array(span), b: new Float32Array(span) };
  for (let i = 0; i < span; i++) {
    const u = (i * step) / tail;
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
  const look = o.mono ? monoLook(o.accent, theme) : STREAK_LOOK[theme];
  const grain = o.grain ?? 1;
  const [pr, pg, pb] = panel;
  out.fill(pack(pr, pg, pb));

  const w = cols * cell - 2 * overhang;
  const h = rows * cell - 2 * overhang;
  const short = Math.max(1, Math.min(w, h));
  const ax = o.anchor.x * w;
  const ay = o.anchor.y * h;
  const angle = Math.atan2(h * (o.rise ?? 1), w);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halfW = Math.max(1, w / 2);

  // Distance tables over the signed distance d from the axis (one step per buffer pixel, index d/cell + cSpan): glow
  // strength, side colour and the core's weight, so a pixel costs a few lookups.
  const warmTail = look.warmTail * short;
  const coolTail = look.coolTail * short;
  const wSpan = Math.ceil((warmTail * CUTOFF) / look.gamma / cell) + 2;
  const cSpan = Math.ceil((coolTail * CUTOFF) / look.gamma / cell) + 2;
  const warm = sideTables(look.warm, warmTail, wSpan, cell, look.gamma);
  const cool = sideTables(look.cool, coolTail, cSpan, cell, look.gamma);
  const span = cSpan + wSpan + 1;
  const tGlow = new Float32Array(span);
  const tCore = new Float32Array(span);
  const tR = new Float32Array(span);
  const tG = new Float32Array(span);
  const tB = new Float32Array(span);
  for (let k = 0; k < span; k++) {
    const i = k - cSpan;
    const side = i >= 0 ? warm : cool;
    const j = i < 0 ? -i : i;
    tGlow[k] = side.glow[j] ?? 0;
    tCore[k] = Math.exp(-(((i * cell) / CORE_PX) ** 2));
    tR[k] = side.r[j] ?? 0;
    tG[k] = side.g[j] ?? 0;
    tB[k] = side.b[j] ?? 0;
  }
  const [kr, kg, kb] = look.core;
  const { coreAlpha, glowAlpha } = look;

  // Per column: the envelope (glow) and its square (core), and the axis's wavy offset — the band runs left to right.
  const envG = new Float32Array(cols);
  const envC = new Float32Array(cols);
  const wave = new Float32Array(cols);
  const waveAmp = WAVE.amp * short;
  for (let x = 0; x < cols; x++) {
    const px = (x + 0.5) * cell - overhang - ax;
    const e = envelope(px / halfW);
    envG[x] = e;
    envC[x] = e * e;
    wave[x] = waveAmp * Math.sin((px / w) * Math.PI * 2 * WAVE.freq + WAVE.phase);
  }

  // The dither as a 64 × 64 tile of triangular values (−1…1) × grain, so a pixel costs one read.
  const noise = grain ? ditherTile(grain) : null;
  const dStep = -cell * sin;
  let brightest = 0;
  for (let y = 0; y < rows; y++) {
    const py = (y + 0.5) * cell - overhang - ay;
    const rowBase = y * cols;
    const nRow = (y & 63) << 6;
    // d / cell + cSpan, linear in x before the wave: one add per pixel.
    let f0 = (-((0.5 * cell - overhang - ax) * sin) + py * cos) / cell + cSpan;
    for (let x = 0; x < cols; x++, f0 += dStep / cell) {
      const eg = envG[x] as number;
      if (eg <= 0) continue;
      // Signed distance from the (wavy) axis in table steps (d > 0 below it, the warm side), read between two
      // entries so the line has no stair-steps.
      const f = f0 - (wave[x] as number) / cell;
      const k = f | 0;
      if (f < 0 || k + 1 >= span) continue;
      const t = f - k;
      const u = 1 - t;
      const glow = ((tGlow[k] as number) * u + (tGlow[k + 1] as number) * t) * glowAlpha * eg;
      const core = ((tCore[k] as number) * u + (tCore[k + 1] as number) * t) * (envC[x] as number);
      const al = glow + core * (coreAlpha - glow);
      if (al < 0.002) continue;
      if (al > brightest) brightest = al;
      const sr = (tR[k] as number) * u + (tR[k + 1] as number) * t;
      const sg = (tG[k] as number) * u + (tG[k + 1] as number) * t;
      const sb = (tB[k] as number) * u + (tB[k + 1] as number) * t;
      // Triangular luminance dither: smooth, but no 8-bit bands in a long low-alpha falloff.
      const n = noise ? (noise[nRow | (x & 63)] as number) : 0;
      out[rowBase + x] = pack(
        clamp255(pr + (sr + (kr - sr) * core - pr) * al + n),
        clamp255(pg + (sg + (kg - sg) * core - pg) * al + n),
        clamp255(pb + (sb + (kb - sb) * core - pb) * al + n),
      );
    }
  }
  return brightest;
}

/** CSS px per buffer pixel for a device pixel ratio: one buffer pixel per device pixel, capped at 2× (the cost). */
export function streakCell(devicePixelRatio: number): number {
  const scale = Math.min(2, Math.max(1, Math.round(devicePixelRatio || 1)));
  return 1 / scale;
}

/** "#rrggbb" or "rgb(r g b)" / "rgb(r, g, b)" → RGB; anything else is null. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(v)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(v);
  if (rgb) return [Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3]))];
  // WebKit can serialise a resolved colour as `color(srgb r g b)` with channels 0–1.
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(v);
  if (srgb) return [Math.round(Number(srgb[1]) * 255), Math.round(Number(srgb[2]) * 255), Math.round(Number(srgb[3]) * 255)];
  // Unreadable: the caller does not draw (never a black fallback: it painted the light theme's start screen black).
  return null;
}
