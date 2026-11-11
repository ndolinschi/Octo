import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { usePresence } from "./Presence";
import { useLatest } from "../../lib/hooks";

const EDGE = 8;
const GAP = 6;

/**
 * A small non-modal panel anchored to the control that opened it (problems list, pending comments).
 * Opens above or below the anchor (flipping to fit), aligned to its start or end edge; focus moves in
 * on open and back to the anchor on close; Esc, a click outside or scrolling the page closes it.
 * Enter/exit motion is the overlay one (instant when opened from the keyboard). Wrap in <Presence>.
 */
export function Popover(props: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onClose(): void;
  side?: "top" | "bottom";
  /** Opens above/below this element instead of the anchor (e.g. the whole composer, not its footer). */
  edge?: () => HTMLElement | null;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const { anchor, onClose, side = "bottom", align = "start" } = props;
  const edge = useLatest(props.edge);
  const ref = useRef<HTMLDivElement>(null);
  const state = usePresence();
  const open = state === "open";
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor.current;
    if (!el || !a) return;
    const place = () => {
      const r = a.getBoundingClientRect();
      const v = edge.current?.()?.getBoundingClientRect() ?? r;
      const { width, height } = el.getBoundingClientRect();
      const roomAbove = v.top - GAP - EDGE;
      const roomBelow = window.innerHeight - v.bottom - GAP - EDGE;
      const up = side === "top" ? height <= roomAbove || roomAbove > roomBelow : height > roomBelow && roomAbove > roomBelow;
      const left = Math.min(Math.max(EDGE, align === "start" ? r.left : r.right - width), window.innerWidth - width - EDGE);
      const top = up ? Math.max(EDGE, v.top - GAP - height) : Math.min(v.bottom + GAP, window.innerHeight - height - EDGE);
      setPos({ left, top, origin: `${align === "start" ? "0%" : "100%"} ${up ? "100%" : "0%"}` });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor, side, align, edge]);

  useEffect(() => {
    const opener = anchor.current;
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus], button:not(:disabled), [tabindex='0']");
    (first ?? ref.current)?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && ref.current?.contains(document.activeElement ?? null)) opener.focus({ preventScroll: true });
    };
  }, [anchor]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    // Only a scroll that moves the anchor closes it: a live transcript scrolling elsewhere must not (v6.3 part 2).
    const scrolled = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && ref.current?.contains(t)) return;
      const a = anchor.current;
      if (t === document || (t instanceof Node && a && t.contains(a))) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      anchor.current?.focus({ preventScroll: true });
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose, anchor]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      data-state={state}
      inert={!open}
      style={pos ? ({ left: pos.left, top: pos.top, "--octo-origin": pos.origin } as CSSProperties) : { left: -9999, top: 0 }}
      className={cn(
        "octo-overlay fixed z-[60] flex max-h-[min(420px,70vh)] flex-col overflow-hidden rounded-lg border border-transparent bg-overlay text-sm shadow-pop focus:outline-none focus-visible:shadow-pop",
        props.className,
      )}
    >
      {props.children}
    </div>,
    document.body,
  );
}
