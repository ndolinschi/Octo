import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/format";
import { MOD_LABEL } from "../../lib/keys";
import { Button } from "../primitives/Button";
import { Presence } from "../primitives/Presence";

const ContextPopover = lazy(() => import("./ContextPopover").then((m) => ({ default: m.ContextPopover })));

/** The wedge is a circle of radius R drawn with a stroke as wide as its diameter: a pie from the centre out to 2R. */
const R = 2.5;
const C = 2 * Math.PI * R;

/**
 * The context indicator (decisions 62, 65): a gauge of how full the context window is — a rim and a filled wedge from twelve
 * o'clock (polish step 3, C6: a pie, so it never reads as the working spinner's arc) — with the percentage beside it once it
 * passes 50% (warn colour from 80%), and a real button: click, Enter or Ctrl/Cmd+Shift+U open the popover — the headline, one
 * stacked bar and a list by category, cached vs. uncached input of the last request, "Compact now" (when the bridge can),
 * and "Open context details". An agent that manages its own context says so. Not rendered while a number is unknown.
 */
export function ContextRing({ used, size }: { used: number | null | undefined; size: number | null | undefined }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "u") {
        // Only a ring that is laid out answers: a composer hidden behind another one still mounts its ring.
        const r = button.current?.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return;
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  if (!used || !size) return null;
  const share = Math.min(1, used / size);
  const pct = Math.round(share * 100);
  const text = `Context: ${formatTokens(used)} of ${formatTokens(size)} tokens (${pct}%)`;
  return (
    <>
      <Button
        ref={button}
        variant="quiet"
        size="sm"
        pressed={open}
        aria-label={text}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Context (${MOD_LABEL}⇧U)`}
        data-context-ring
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden data-gauge className="-rotate-90">
          <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-fg-3" />
          <circle
            cx="8"
            cy="8"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth={2 * R}
            strokeDasharray={`${Math.max(0.04 * C, share * C)} ${C}`}
            className={cn(share >= 0.8 ? "text-warn" : "text-fg-2")}
          />
        </svg>
        {share > 0.5 && <span className={cn("text-xs tabular-nums", share >= 0.8 ? "text-warn" : "text-fg-3")}>{pct}%</span>}
      </Button>
      <Presence show={open} exitMs={0}>
        {open && (
          <Suspense fallback={null}>
            <ContextPopover anchor={button} used={used} size={size} onClose={() => setOpen(false)} />
          </Suspense>
        )}
      </Presence>
    </>
  );
}
