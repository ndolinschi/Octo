import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/format";

const R = 6;
const C = 2 * Math.PI * R;

/**
 * The context meter (decision 62): a 16px ring of how full the agent's context window is; the numbers are in the
 * tooltip and the accessible name. Warn colour from 80%. Not rendered while either number is unknown.
 */
export function ContextRing({ used, size }: { used: number | null | undefined; size: number | null | undefined }) {
  if (!used || !size) return null;
  const share = Math.min(1, used / size);
  const pct = Math.round(share * 100);
  const text = `Context: ${formatTokens(used)} of ${formatTokens(size)} tokens (${pct}%)`;
  return (
    <span role="img" aria-label={text} title={text} data-context-ring className="grid size-7 shrink-0 place-items-center">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
        <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeWidth="2" className="text-line-strong" />
        <circle
          cx="8"
          cy="8"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(0.5, share * C)} ${C}`}
          className={cn(share >= 0.8 ? "text-warn" : "text-fg-3")}
        />
      </svg>
    </span>
  );
}
