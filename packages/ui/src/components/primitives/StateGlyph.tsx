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
 * Idle is a small quiet dot with no ring (polish step 2, F2), the same in every list.
 * 12px (14 in 36/40px rows), drawn in `currentColor` so forced colours keep it. The working arc turns (1 s) and the
 * needs-you dot is static (decision 76); the arc turns only without reduced motion (`.octo-ring-*` in styles.css). `label` adds screen-reader
 * text; without it the glyph is decorative (the row says the state in words).
 */
export function StateGlyph(props: {
  state: GlyphState;
  size?: GlyphSize;
  box?: number;
  label?: boolean;
  /** Drawn in `fg-3` whatever the state (a count of zero on Home: the tile is wholly quiet, polish step 2 F5). */
  quiet?: boolean;
  className?: string;
}) {
  const size = props.size ?? 12;
  const g = glyphGeometry(props.state, size);
  const box = props.box ?? size;
  return (
    <span
      data-state-glyph={props.state}
      className={cn("inline-grid shrink-0 place-items-center", props.quiet ? "text-fg-3" : TONE[GLYPH_TONE[props.state]], props.className)}
      style={{ width: box, height: box }}
      title={props.label ? glyphLabel(props.state) : undefined}
    >
      <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" stroke="currentColor" strokeWidth={GLYPH_STROKE}>
        {g.ring && (
          <circle
            cx={g.c}
            cy={g.c}
            r={g.r}
            strokeWidth={g.stroke}
            strokeOpacity={g.ringOpacity}
            strokeDasharray={g.dash ?? undefined}
            className={cn(props.state === "working" && "text-fg-3")}
          />
        )}
        {g.arc && <path d={g.arc} strokeLinecap="round" className="octo-ring-turn" />}
        {g.dot !== null && <circle cx={g.c} cy={g.c} r={g.dot} fill="currentColor" fillOpacity={g.dotOpacity} stroke="none" />}
        {g.alert && (
          <g className="octo-ring-pulse">
            <line x1={g.alert.x} y1={g.alert.y1} x2={g.alert.x} y2={g.alert.y2} strokeLinecap="round" />
            <circle cx={g.alert.x} cy={g.alert.cy} r={g.alert.dr} fill="currentColor" stroke="none" />
          </g>
        )}
        {g.bar && <line {...g.bar} strokeLinecap="round" />}
        {g.square && <rect x={g.square.x} y={g.square.x} width={g.square.side} height={g.square.side} rx={g.square.rx} fill="currentColor" stroke="none" />}
      </svg>
      {props.label && <span className="sr-only">{glyphLabel(props.state)}</span>}
    </span>
  );
}
