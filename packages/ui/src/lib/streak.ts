/**
 * The dithered light streak's pixels (decision 21b, the second version), as a pure function over a pixel buffer so
 * it can be measured and tested without a browser. One band along the host's diagonal (top-left → bottom-right)
 * through `anchor`: a hot core (≈ 18% of the shorter side, three lobes at slightly different angles so its edges are
 * irregular, a near-white highlight on its upper edge), a cool halo (≈ 45%) and a fainter echo band below. Colour
 * follows the band's energy — falloff navy → accent blue → violet → hot pink → amber at the core — and the band's
 * strength is quantised to 5 levels (the same step on every channel) with a 4×4 Bayer ordered dither, one value per
 * cell (3–4 CSS px), so the steps read as grain. A static sparse noise field (≈ 3% of cells at 6–10%) covers the whole background.
 */

/** 4×4 Bayer matrix (0–15), row-major. */
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

/** Where the band's centre line passes, as fractions of the host's width and height. */
export type StreakAnchor = { x: number; y: number };

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
  panel: Rgb;
  accent: Rgb;
  theme: StreakTheme;
  /** Quantisation levels per channel (decision 21b: 5). */
  levels?: number;
  /** Share of cells lit by the background noise (≈ 0.03). */
  noise?: number;
};

/** Our ramp (decision 21b), from the falloff to the hottest core. */
const HOT_AMBER: Rgb = [0xff, 0x7a, 0x3d];
const HOT_PINK: Rgb = [0xff, 0x3d, 0x6e];
const VIOLET: Rgb = [0x7a, 0x5c, 0xff];
const FALLOFF_DARK: Rgb = [0x1b, 0x2a, 0x5e];
const FALLOFF_LIGHT: Rgb = [0xdf, 0xe8, 0xff];
const HIGHLIGHT: Rgb = [0xea, 0xf2, 0xff];

/** Peak alpha of the core and the halo per theme (decision 21b: dark 95% / 60%, light 55% / 35%). */
export const STREAK_ALPHA = { dark: { core: 0.95, halo: 0.6 }, light: { core: 0.55, halo: 0.35 } } as const;

/** Core and halo widths as fractions of the shorter side (full width at ~2σ either side). */
const CORE = 0.18;
const HALO = 0.45;
/** Lobes of the core: offset across (× core σ), angle off the diagonal (radians), amplitude, along-band waviness. */
const LOBES = [
  { off: 0.35, tilt: -0.035, amp: 0.85, freq: 1.3, phase: 0.4 },
  { off: 0, tilt: 0, amp: 1, freq: 0.8, phase: 2.1 },
  { off: -0.45, tilt: 0.045, amp: 0.7, freq: 1.9, phase: 4.0 },
] as const;
/** The echo band: offset below the centre line (× shorter side), width (× shorter side), amplitude. */
const ECHO = { off: 0.46, width: 0.1, amp: 0.24 } as const;
/** Value where the alpha ramp reaches the halo's peak (below: halo, above: core). */
const HALO_V = 0.55;

const pack = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** The ramp's colour at `t` (0 falloff … 1 amber core), linear between stops. */
export function rampColor(t: number, accent: Rgb, theme: StreakTheme): [number, number, number] {
  const stops: readonly (readonly [number, Rgb])[] = [
    [0, theme === "dark" ? FALLOFF_DARK : FALLOFF_LIGHT],
    [0.3, accent],
    [0.56, VIOLET],
    [0.8, HOT_PINK],
    [1, HOT_AMBER],
  ];
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i] as readonly [number, Rgb];
    if (x <= t1) {
      const [t0, c0] = stops[i - 1] as readonly [number, Rgb];
      const f = (x - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return [HOT_AMBER[0], HOT_AMBER[1], HOT_AMBER[2]];
}

/** Alpha for a band value (0–1): rises to the halo peak at `HALO_V`, then to the core peak at 1. */
export function bandAlpha(v: number, theme: StreakTheme): number {
  const { core, halo } = STREAK_ALPHA[theme];
  if (v <= 0) return 0;
  if (v <= HALO_V) return (v / HALO_V) * halo;
  return halo + ((Math.min(1, v) - HALO_V) / (1 - HALO_V)) * (core - halo);
}

/** A cheap integer hash of a cell (the noise field is static, so it is the same on every draw). */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Fills `out` (RGBA as little-endian uint32, `cols × rows`) and returns the brightest band alpha drawn. */
export function renderStreak(out: Uint32Array, o: StreakOptions): number {
  const { cols, rows, cell, overhang, panel, accent, theme } = o;
  const levels = o.levels ?? 5;
  const noise = o.noise ?? 0.03;
  const w = cols * cell - 2 * overhang;
  const h = rows * cell - 2 * overhang;
  const short = Math.max(1, Math.min(w, h));
  const ax = o.anchor.x * w;
  const ay = o.anchor.y * h;
  // The host's diagonal, top-left → bottom-right.
  const angle = Math.atan2(h, w);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const sc = (CORE * short) / 2.9;
  const sh = (HALO * short) / 4;
  const se = (ECHO.width * short) / 4;
  const echoOff = ECHO.off * short;
  const length = Math.hypot(w, h);

  // Lookup tables at 1 CSS px over the distance across the band (d) and along it (s): a cell costs lookups only.
  const dMax = Math.ceil(Math.max(3 * sh, echoOff + 3 * se) + sc * 2) + 2;
  const span = 2 * dMax + 1;
  const haloTab = new Float32Array(span);
  const coreTab = new Float32Array(span);
  const echoTab = new Float32Array(span);
  const lightTab = new Float32Array(span);
  for (let i = 0; i < span; i++) {
    const d = i - dMax;
    // The halo spreads further above the core than below it (the reference's soft upper glow, a sharper lower edge).
    const sigma = d < 0 ? sh * 2 : sh * 0.7;
    haloTab[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    coreTab[i] = Math.exp(-(d * d) / (2 * sc * sc));
    echoTab[i] = ECHO.amp * Math.exp(-((d - echoOff) ** 2) / (2 * se * se));
    // The highlight: a thin line along the core's upper edge.
    const hl = d + 1.55 * sc;
    lightTab[i] = Math.exp(-(hl * hl) / (2 * (0.22 * sc) ** 2));
  }
  const reach = Math.ceil(length) + 2 * overhang + 4;
  const sSpan = 2 * reach + 1;
  const along = LOBES.map((l) => {
    const t = new Float32Array(sSpan);
    for (let i = 0; i < sSpan; i++) t[i] = l.amp * (0.78 + 0.22 * Math.sin(((i - reach) / length) * Math.PI * 2 * l.freq + l.phase));
    return t;
  });
  const [a0, a1, a2] = along as [Float32Array, Float32Array, Float32Array];
  const [l0, l1, l2] = LOBES;
  const off0 = l0.off * sc;
  const off1 = l1.off * sc;
  const off2 = l2.off * sc;

  const base = pack(panel[0], panel[1], panel[2]);
  const peak = STREAK_ALPHA[theme].core;
  const noiseCut = Math.round(noise * 4096);
  let brightest = 0;
  for (let y = 0; y < rows; y++) {
    const py = y * cell + cell / 2 - overhang - ay;
    const bRow = (y & 3) * 4;
    const rowBase = y * cols;
    for (let x = 0; x < cols; x++) {
      const px = x * cell + cell / 2 - overhang - ax;
      // d > 0 is below the centre line (toward the bottom-left), s runs along it.
      const d = -px * sin + py * cos;
      const s = px * cos + py * sin;
      const di = Math.round(d) + dMax;
      const si = Math.round(s) + reach;
      const threshold = ((BAYER4[bRow + (x & 3)] as number) + 0.5) / 16;
      if (di < 0 || di >= span || si < 0 || si >= sSpan) {
        // Outside the band: the panel, and the sparse noise field.
        const hv = hash(x, y);
        out[rowBase + x] = (hv & 4095) < noiseCut ? noisePixel(hv, panel, accent, theme) : base;
        continue;
      }
      // Three lobes, each at its own slight angle (an irregular edge): their distances differ by s · tilt.
      const c0 = coreTab[clampIndex(Math.round(d - off0 + s * l0.tilt) + dMax, span)] as number;
      const c1 = coreTab[clampIndex(Math.round(d - off1 + s * l1.tilt) + dMax, span)] as number;
      const c2 = coreTab[clampIndex(Math.round(d - off2 + s * l2.tilt) + dMax, span)] as number;
      const core = Math.max(c0 * (a0[si] as number), c1 * (a1[si] as number), c2 * (a2[si] as number));
      const halo = haloTab[di] as number;
      const echo = echoTab[di] as number;
      const v0 = 0.68 * halo + 0.55 * core + echo;
      const v = v0 > 1 ? 1 : v0;
      if (v < 0.012) {
        const hv = hash(x, y);
        out[rowBase + x] = (hv & 4095) < noiseCut ? noisePixel(hv, panel, accent, theme) : base;
        continue;
      }
      // Colour by energy: the halo (and the echo) run falloff → accent, the core accent → violet → pink → amber;
      // warmer on the core's lower edge, cooler above it (temperature contrast across the band).
      const tilt = core * (d > 0 ? 0.12 : -0.08);
      const [cr, cg, cb] = rampColor(0.3 * Math.sqrt(Math.min(1, halo + echo * 1.5)) + 0.78 * core + tilt, accent, theme);
      const hl = (lightTab[di] as number) * core * 0.85;
      const r = cr + (HIGHLIGHT[0] - cr) * hl;
      const g = cg + (HIGHLIGHT[1] - cg) * hl;
      const b = cb + (HIGHLIGHT[2] - cb) * hl;
      const a = bandAlpha(v, theme);
      if (a > brightest) brightest = a;
      // The band's strength is quantised to `levels` steps with the ordered dither (the same step for all three
      // channels, so the grain never splits the hue into rainbow fringes); its colour stays continuous.
      const aq = quantizeAlpha(a, peak, levels, threshold);
      const qr = (r - panel[0]) * aq;
      const qg = (g - panel[1]) * aq;
      const qb = (b - panel[2]) * aq;
      out[rowBase + x] = pack(clamp255(panel[0] + qr), clamp255(panel[1] + qg), clamp255(panel[2] + qb));
    }
  }
  return brightest;
}

/** The band's strength on one of `levels` steps between 0 and `peak` (ordered dither: `threshold` ∈ [0, 1)). */
export function quantizeAlpha(a: number, peak: number, levels: number, threshold: number): number {
  return Math.min(peak, (Math.floor((a / peak) * (levels - 1) + threshold) / (levels - 1)) * peak);
}

function clampIndex(i: number, span: number): number {
  return i < 0 ? 0 : i >= span ? span - 1 : i;
}

/** One lit noise cell: a ramp hue at 6–10% over the panel. */
function noisePixel(hv: number, panel: Rgb, accent: Rgb, theme: StreakTheme): number {
  const t = ((hv >>> 12) & 255) / 255;
  const a = 0.06 + (((hv >>> 20) & 15) / 15) * 0.04;
  const [r, g, b] = rampColor(0.2 + t * 0.8, accent, theme);
  return pack(clamp255(panel[0] + (r - panel[0]) * a), clamp255(panel[1] + (g - panel[1]) * a), clamp255(panel[2] + (b - panel[2]) * a));
}

/** The dither cell in CSS px for a host width (decision 21b: 3, or 4 from 1920 wide). */
export function streakCell(width: number): number {
  return width >= 1920 ? 4 : 3;
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
