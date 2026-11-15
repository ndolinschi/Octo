import type { AgentStatus } from "@octo/agent-client";

/**
 * Decision 29 — one state-glyph family. Every state is a ring of one diameter and a 1.5px stroke; the state is told
 * by line style and motion first, colour second (so it survives colour blindness and forced colours):
 * working = faint ring + a turning 90° arc · queued = dashed ring (6 dashes) · needs = ring + an exclamation mark (pulsing) ·
 * unseen = ring + filled disc · idle = a small quiet dot with no ring (polish step 2, F2: a thin ring read as a radio button;
 * revises decision 29's idle ring) · failed = ring + a short diagonal bar · stopped = ring + a small filled square (R2,
 * design study B(d): the media "stop"; it was idle's dot, which read lighter than ✓, ⊘ and ! beside it, and as idle). Pure
 * geometry here; the SVG is
 * `primitives/StateGlyph.tsx`.
 */
export type GlyphState = "working" | "queued" | "needs" | "unseen" | "idle" | "failed" | "stopped";
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
  stopped: "fg-3",
};

const LABEL: Record<GlyphState, string> = {
  working: "Working",
  queued: "Not started",
  needs: "Needs you",
  unseen: "New activity",
  idle: "Idle",
  failed: "Failed",
  stopped: "Stopped",
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
  /** Stroke width of the ring: 1.5 (idle draws no ring). */
  stroke: number;
  /** Whether the ring is drawn: every state but idle, which is only its dot. */
  ring: boolean;
  /** Opacity of the ring (the working ring is faint under its arc). */
  ringOpacity: number;
  /** The working arc as an SVG path (90°, from 12 o'clock clockwise). */
  arc: string | null;
  /** The filled disc: unseen's inside its ring, idle's on its own (smaller, quiet). */
  dot: number | null;
  /** Opacity of the disc: idle's dot is quiet (0.7 keeps it at or above 3:1 on the window in both themes). */
  dotOpacity: number;
  /**
   * Needs you: an exclamation mark inside the ring (a short upright stroke over a dot), so it never reads as unseen's
   * disc in greyscale (owner's live test: the two differed only by colour).
   */
  alert: { x: number; y1: number; y2: number; cy: number; dr: number } | null;
  /** The failed state's bar. */
  bar: { x1: number; y1: number; x2: number; y2: number } | null;
  /** The stopped state's filled square, centred (side and corner radius). */
  square: { x: number; side: number; rx: number } | null;
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Idle's dot: 6px across, the size of the sidebar's dot in step 1. */
export const IDLE_DOT_R = 3;
export const IDLE_DOT_OPACITY = 0.7;

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

/** The stopped square: about the inner diameter's half, on whole pixels so it stays crisp (4px at 14, 3px at 12). */
function stopSquare(c: number, inner: number): { x: number; side: number; rx: number } {
  const side = Math.round(inner * 0.94);
  return { x: round(c - side / 2), side, rx: 0.75 };
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
    stroke: GLYPH_STROKE,
    ring: state !== "idle",
    dash: state === "queued" ? dashArray(r) : null,
    ringOpacity: state === "working" ? 0.4 : 1,
    arc: state === "working" ? arcPath(c, r) : null,
    dot: state === "unseen" ? round(inner * 0.75) : state === "idle" ? IDLE_DOT_R : null,
    dotOpacity: state === "idle" ? IDLE_DOT_OPACITY : 1,
    alert:
      state === "needs"
        ? { x: round(c), y1: round(c - inner * 0.62), y2: round(c + inner * 0.12), cy: round(c + inner * 0.55), dr: round(Math.max(0.6, inner * 0.2)) }
        : null,
    bar: state === "failed" ? { x1: round(c - d), y1: round(c + d), x2: round(c + d), y2: round(c - d) } : null,
    square: state === "stopped" ? stopSquare(c, inner) : null,
  };
}

/** A sub-agent's ring: running → working, failed → failed, stopped → stopped (R2), everything finished → idle (or unseen when asked). */
export function agentGlyph(status: AgentStatus, unseen = false): GlyphState {
  if (status === "running") return "working";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  return unseen ? "unseen" : "idle";
}

/** A project orchestrator's ring (sidebar, Home, header): "new" (no request yet) is the dashed, not-started ring. */
export function orchestratorGlyph(kind: "working" | "needs" | "idle" | "new", unseen = false): GlyphState {
  if (kind === "working") return "working";
  if (kind === "needs") return "needs";
  if (unseen) return "unseen";
  return kind === "new" ? "queued" : "idle";
}
