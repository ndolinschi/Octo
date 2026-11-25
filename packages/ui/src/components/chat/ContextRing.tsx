import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { contextView } from "../../lib/contextView";
import { formatTokens } from "../../lib/format";
import { MOD_LABEL } from "../../lib/keys";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { Presence } from "../primitives/Presence";

const ContextPopover = lazy(() => import("./ContextPopover").then((m) => ({ default: m.ContextPopover })));

/** The gauge is a 2px arc on the track ring's radius, from twelve o'clock. */
const R = 6.75;
const C = 2 * Math.PI * R;

/**
 * The context indicator (decisions 62, 65): a gauge of how full the context window is — a track ring and a 2px arc from twelve
 * o'clock (a filled pie read as a theme icon at 16px) — with the percentage beside it once it
 * passes 50% (warn colour from 80%), and a real button: click, Enter or Ctrl/Cmd+Shift+U open the popover — the headline, one
 * stacked bar and a list by category, cached vs. uncached input of the last request, "Compact now" (when the bridge can),
 * and "Open context details". An agent that manages its own context says so. Not rendered while a number is unknown.
 *
 * B5: the ring and its popover show one number. The ring reads the same context overview the popover reads (again on
 * `context.updated`) and hands its numbers to the popover; the composer's last-turn numbers stand in until it is in, or when
 * the bridge has no overview.
 */
export function ContextRing(props: { used: number | null | undefined; size: number | null | undefined }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { bridge } = useApp();
  const { projectId, onEvent } = useProject();
  const [overview, setOverview] = useState<{ used: number; size: number | null } | null>(null);
  const load = useCallback(() => {
    if (!bridge.getContextOverview) return;
    bridge.getContextOverview(projectId).then(
      (raw) => {
        const v = contextView(raw);
        setOverview({ used: v.used, size: v.window });
      },
      // Unreadable: the last turn's numbers stay.
      () => undefined,
    );
  }, [bridge, projectId]);
  // Read again when the last turn's numbers move (a turn ended) and on `context.updated`.
  useEffect(load, [load, props.used]);
  useEffect(() => onEvent((e) => e.type === "context.updated" && load()), [onEvent, load]);
  const used = overview ? overview.used : props.used;
  const size = overview?.size ?? props.size;
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
  const text = `Context: ${pct}% full (${formatTokens(used)} of ${formatTokens(size)})`;
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
        className={share <= 0.5 ? "w-7 justify-center rounded-full px-0" : undefined}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden data-gauge className="-rotate-90">
          <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeWidth="2" className="text-line-strong" />
          <circle
            cx="8"
            cy="8"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
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
