import { useEffect, useState } from "react";
import { markInitial } from "../../lib/providerMark";

type Marks = typeof import("./providerMarkAssets");
let marks: Marks | null = null;

/**
 * Decision 72 (a), overridden by the owner: the mark that starts a provider row, chip and Settings row is the vendor's real
 * logo, drawn in the surrounding text colour (a CSS mask over the SVG file, so it works in light and dark and costs the
 * entry bundle almost nothing). Rule: a provider row shows the provider's mark; a model chip shows the model's vendor, or the
 * agent CLI's mark when the model runs through an agent. `id` is a provider id or a model id. An id with no vendor mark (and
 * our own router) keeps the neutral shape, with its initial from a 20px mark up (6f: no letter under 9px). The box has its final size before anything loads: no layout shift.
 */
export function ProviderMark({ id, label, size = 16, className }: { id: string; label: string; size?: number; className?: string }) {
  const [, loaded] = useState(0);
  useEffect(() => {
    if (!marks)
      void import("./providerMarkAssets").then((m) => {
        marks = m;
        loaded((n) => n + 1);
      });
  }, []);
  const mark = marks?.markOf(id, label);
  const url = mark && "url" in mark ? mark.url : undefined;
  if (mark && !url && "d" in mark) {
    const initial = markInitial(size);
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden data-provider-mark={id} className={`shrink-0 ${className ?? ""}`}>
        <path d={mark.d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {initial && (
          <text x="8" y={mark.y} textAnchor="middle" fontSize={initial.units} fontWeight="600" fill="currentColor" fontFamily="inherit">
            {mark.initial}
          </text>
        )}
      </svg>
    );
  }
  // Until the marks' chunk arrives the box is empty and already its final size.
  return (
    <span
      aria-hidden
      data-provider-mark={id}
      // 6d: forced colours would paint the masked fill Canvas (the mark vanished); there it is CanvasText, unforced.
      className={`inline-block shrink-0 ${url ? "bg-current mask-contain mask-center mask-no-repeat forced-colors:bg-[CanvasText] forced-colors:forced-color-adjust-none" : ""} ${className ?? ""}`}
      style={{ width: size, height: size, ...(url ? { maskImage: `url("${url}")` } : {}) }}
    />
  );
}
