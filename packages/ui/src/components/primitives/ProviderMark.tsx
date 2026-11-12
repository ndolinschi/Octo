import { cn } from "../../lib/cn";

type Shape = "circle" | "square" | "diamond" | "hex" | "tri";

/** A distinct simple shape per known provider; any other id gets one from its letters, so the same provider always looks the same. */
const KNOWN: Record<string, Shape> = {
  api: "hex",
  router: "diamond",
  "claude-code": "circle",
  codex: "square",
  copilot: "tri",
  grok: "diamond",
  opencode: "hex",
};
const SHAPES: readonly Shape[] = ["circle", "square", "diamond", "hex", "tri"];

function shapeOf(id: string): Shape {
  const known = KNOWN[id];
  if (known) return known;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997;
  return SHAPES[h % SHAPES.length] ?? "circle";
}

const OUTLINE: Record<Shape, string> = {
  circle: "M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13Z",
  square: "M4 1.5h8a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 12V4A2.5 2.5 0 0 1 4 1.5Z",
  diamond: "M8 1l6.5 7L8 15L1.5 8Z",
  hex: "M8 1.2l5.9 3.4v6.8L8 14.8l-5.9-3.4V4.6Z",
  tri: "M8 1.8l6.4 11.4H1.6Z",
};

/**
 * Decision 72 (a): the 16px mark that starts a provider row, chip and Settings row. Our own neutral glyph, never a vendor
 * logo: one simple shape per provider with its initial inside, in the surrounding text colour.
 */
export function ProviderMark({ id, label, size = 16, className }: { id: string; label: string; size?: number; className?: string }) {
  const shape = shapeOf(id);
  const initial = (label.trim().charAt(0) || id.charAt(0) || "?").toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden data-provider-mark={id} className={cn("shrink-0", className)}>
      <path d={OUTLINE[shape]} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <text x="8" y={shape === "tri" ? 11.6 : 10.6} textAnchor="middle" fontSize="7.5" fontWeight="600" fill="currentColor" fontFamily="inherit">
        {initial}
      </text>
    </svg>
  );
}
