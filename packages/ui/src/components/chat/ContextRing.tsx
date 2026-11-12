import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/format";
import { MOD_LABEL } from "../../lib/keys";
import { Presence } from "../primitives/Presence";

const ContextPopover = lazy(() => import("./ContextPopover").then((m) => ({ default: m.ContextPopover })));

const R = 6;
const C = 2 * Math.PI * R;

/**
 * The context indicator (decisions 62, 65): a ring of how full the context window is, with the percentage beside it once it
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
      <button
        ref={button}
        type="button"
        aria-label={text}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Context (${MOD_LABEL}⇧U)`}
        data-context-ring
        onClick={() => setOpen((o) => !o)}
        className={cn("flex h-7 shrink-0 press items-center gap-1 rounded-sm px-1.5 hover:bg-hover", open && "bg-hover")}
      >
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
        {share > 0.5 && <span className={cn("text-xs tabular-nums", share >= 0.8 ? "text-warn" : "text-fg-3")}>{pct}%</span>}
      </button>
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
