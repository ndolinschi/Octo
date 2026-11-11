import type { AgentStatus } from "@octo/agent-client";

/**
 * Decision 29 — one state-glyph family. Every state is a ring of one diameter and a 1.5px stroke; the state is told
 * by line style and motion first, colour second (so it survives colour blindness and forced colours):
 * working = faint ring + a turning 90° arc · queued = dashed ring (6 dashes) · needs = ring + pulsing centre dot ·
 * unseen = ring + filled disc · idle = thin ring · failed = ring + a short diagonal bar. Pure geometry here; the SVG is
 * `primitives/StateGlyph.tsx`.
 */
export type GlyphState = "working" | "queued" | "needs" | "unseen" | "idle" | "failed";
export type GlyphSize = 12 | 14;

export const GLYPH_STROKE = 1.5;
export const GLYPH_DASHES = 6;

/** Colour role of each state (a token name; the component maps it to a class). */
export const GLYPH_TONE: Record<GlyphState, "fg" | "fg-3" | "warn" | "accent" | "err"> = {
  working: "fg",
  queued: "fg-3",
  needs: "warn",
  unseen: "accent",
  idle: "fg-3",
  failed: "err",
};

const LABEL: Record<GlyphState, string> = {
  working: "Working",
  queued: "Not started",
  needs: "Needs you",
  unseen: "New activity",
  idle: "Idle",
  failed: "Failed",
};

export function glyphLabel(state: GlyphState): string {
  return LABEL[state];
}

export type Geometry = {
  size: GlyphSize;
  c: number;
  r: number;
  /** stroke-dasharray of the ring, when dashed. */
  dash: string | null;
  /** Stroke width: 1.5, and 1 for the idle ring ("a solid thin ring"), so a working row out-weighs an idle one. */
  stroke: number;
  /** Opacity of the ring (the working ring is faint under its arc). */
  ringOpacity: number;
  /** The working arc as an SVG path (90°, from 12 o'clock clockwise). */
  arc: string | null;
  /** A centre dot (needs you) or disc (unseen): its radius. */
  dot: number | null;
  /** The failed state's bar. */
  bar: { x1: number; y1: number; x2: number; y2: number } | null;
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The ring's radius: the stroke sits inside the box with half a pixel to spare, so it never clips. */
export function ringRadius(size: GlyphSize): number {
  return round((size - GLYPH_STROKE) / 2 - 0.5);
}

/** Dash and gap of `n` equal dashes around a circle of radius r (dashes 60% of each period). */
export function dashArray(r: number, n = GLYPH_DASHES): string {
  const period = (2 * Math.PI * r) / n;
  return `${round(period * 0.6)} ${round(period * 0.4)}`;
}

/** An arc of `deg` degrees on a circle around (c, c), starting at 12 o'clock, clockwise. */
export function arcPath(c: number, r: number, deg = 90): string {
  const a = (deg * Math.PI) / 180;
  const x = round(c + r * Math.sin(a));
  const y = round(c - r * Math.cos(a));
  return `M${round(c)} ${round(c - r)}A${r} ${r} 0 ${deg > 180 ? 1 : 0} 1 ${x} ${y}`;
}

export function glyphGeometry(state: GlyphState, size: GlyphSize = 12): Geometry {
  const c = size / 2;
  const r = ringRadius(size);
  const inner = r - GLYPH_STROKE;
  const d = round(inner * Math.SQRT1_2);
  return {
    size,
    c,
    r,
    stroke: state === "idle" ? 1 : GLYPH_STROKE,
    dash: state === "queued" ? dashArray(r) : null,
    ringOpacity: state === "working" ? 0.4 : 1,
    arc: state === "working" ? arcPath(c, r) : null,
    dot: state === "needs" ? round(inner * 0.5) : state === "unseen" ? round(inner * 0.75) : null,
    bar: state === "failed" ? { x1: round(c - d), y1: round(c + d), x2: round(c + d), y2: round(c - d) } : null,
  };
}

/** A sub-agent's ring: running → working, failed → failed, everything finished → idle (or unseen when asked). */
export function agentGlyph(status: AgentStatus, unseen = false): GlyphState {
  if (status === "running") return "working";
  if (status === "failed") return "failed";
  return unseen ? "unseen" : "idle";
}

/** A project orchestrator's ring (sidebar, Home, header): "new" (no request yet) is the dashed, not-started ring. */
export function orchestratorGlyph(kind: "working" | "needs" | "idle" | "new", unseen = false): GlyphState {
  if (kind === "working") return "working";
  if (kind === "needs") return "needs";
  if (unseen) return "unseen";
  return kind === "new" ? "queued" : "idle";
}
