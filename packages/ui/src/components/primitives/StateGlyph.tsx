import { cn } from "../../lib/cn";
import { GLYPH_STROKE, GLYPH_TONE, glyphGeometry, glyphLabel, type GlyphSize, type GlyphState } from "../../lib/stateGlyph";

const TONE: Record<(typeof GLYPH_TONE)[GlyphState], string> = {
  fg: "text-fg",
  "fg-3": "text-fg-3",
  warn: "text-warn",
  accent: "text-accent",
  err: "text-err",
};

/**
 * Decision 29: the one state glyph (ring family) — sidebar rows, tabs, team chips, Home, delegation rows, the palette.
 * 12px (14 in 36/40px rows), drawn in `currentColor` so forced colours keep it. The working arc turns (1 s) and the
 * needs-you dot pulses (2 s) only without reduced motion (`.octo-ring-*` in styles.css). `label` adds screen-reader
 * text; without it the glyph is decorative (the row says the state in words).
 */
export function StateGlyph(props: { state: GlyphState; size?: GlyphSize; box?: number; label?: boolean; className?: string }) {
  const size = props.size ?? 12;
  const g = glyphGeometry(props.state, size);
  const box = props.box ?? size;
  return (
    <span
      data-state-glyph={props.state}
      className={cn("inline-grid shrink-0 place-items-center", TONE[GLYPH_TONE[props.state]], props.className)}
      style={{ width: box, height: box }}
      title={props.label ? glyphLabel(props.state) : undefined}
    >
      <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" stroke="currentColor" strokeWidth={GLYPH_STROKE}>
        <circle
          cx={g.c}
          cy={g.c}
          r={g.r}
          strokeWidth={g.stroke}
          strokeOpacity={g.ringOpacity}
          strokeDasharray={g.dash ?? undefined}
          className={cn(props.state === "working" && "text-fg-3")}
        />
        {g.arc && <path d={g.arc} strokeLinecap="round" className="octo-ring-turn" />}
        {g.dot !== null && (
          <circle cx={g.c} cy={g.c} r={g.dot} fill="currentColor" stroke="none" className={cn(props.state === "needs" && "octo-ring-pulse")} />
        )}
        {g.bar && <line {...g.bar} strokeLinecap="round" />}
      </svg>
      {props.label && <span className="sr-only">{glyphLabel(props.state)}</span>}
    </span>
  );
}
