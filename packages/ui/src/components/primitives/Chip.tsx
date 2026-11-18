import { ChevronDown, type LucideIcon } from "lucide-react";
import { forwardRef, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "./Glyph";
import { MiddleText } from "./MiddleText";

/**
 * A ghost chip (decision 62: the composer's control row, and the same model chip in the title bar): 28px, glyph + label + one small down chevron (12px,
 * `fg-3`; E2, owner 2026-11-18: the up-down pair read as noise four times in a row). `bare` drops the label (the row is too narrow); the accessible name keeps it.
 */
export const Chip = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: LucideIcon;
    /** Instead of `icon`: a 14px provider mark. */
    lead?: ReactNode;
    label: string;
    name: string;
    tip?: string | undefined;
    bare?: boolean;
    open?: boolean;
    warn?: boolean;
    /** A title (a session's) is cut at its end; a path or name keeps both ends (the default, `MiddleText`). */
    cut?: "middle" | "end";
    /**
     * Item 10: `label` in two parts ("Claude Code · " + "Opus 5.5"): when the chip must shorten, the first part goes first
     * (whole, never half-cut) and the second keeps the chip's line, cut at its end only when it alone does not fit.
     */
    parts?: { provider: string; model: string } | null | undefined;
  }
>(function Chip({ icon, lead, label, name, tip, bare = false, open = false, warn = false, cut = "middle", parts, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-composer-chip
      aria-label={`${name}: ${label}`}
      title={tip ?? `${name}: ${label}`}
      aria-expanded={open}
      className={cn(
        "touch-hit flex h-ctl-sm min-w-0 shrink-0 press items-center gap-1.5 rounded-sm text-sm hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50",
        bare ? "w-ctl-sm justify-center" : "px-2",
        open ? "bg-active text-fg" : warn ? "text-warn" : "text-fg-2",
        className,
      )}
      {...rest}
    >
      {lead ?? (icon && <Glyph icon={icon} size={14} className="shrink-0" />)}
      {!bare && (
        <span data-chip-label className="flex min-w-0 items-center gap-1.5">
          {parts ? <PartsLabel key={label} parts={parts} /> : cut === "end" ? <span className="min-w-0 truncate">{label}</span> : <MiddleText text={label} />}
          <Glyph icon={ChevronDown} size={12} className="shrink-0 text-fg-3" />
        </span>
      )}
    </button>
  );
});

/**
 * Item 10: the label of a chip with two parts. When the whole label does not fit the room the chip gets (its max width, or
 * what its row leaves it), only the model part shows: the provider part goes whole, never half-cut, and the chip shrinks to
 * what it shows. The model part is cut at its end only when it alone does not fit. The whole label comes back when the row
 * grows past the width at which it was dropped.
 */
function PartsLabel({ parts }: { parts: { provider: string; model: string } }) {
  const shown = useRef<HTMLSpanElement>(null);
  const [short, setShort] = useState(false);
  const droppedAt = useRef(0);
  useLayoutEffect(() => {
    const el = shown.current;
    const row = el?.closest("button")?.parentElement;
    if (!el || !row) return;
    const check = () => {
      if (!short) {
        if (el.scrollWidth > el.clientWidth + 0.5) {
          droppedAt.current = row.clientWidth;
          setShort(true);
        }
      } else if (row.clientWidth > droppedAt.current + 0.5) setShort(false);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(row);
    // The label's width changes when the web font arrives, the row's does not.
    let alive = true;
    void document.fonts.ready.then(() => alive && check());
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [short, parts.provider, parts.model]);
  return (
    <span ref={shown} className="min-w-0 truncate">
      {short ? parts.model : `${parts.provider}${parts.model}`}
    </span>
  );
}
