import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { usePresence } from "./Presence";
import { useLatest } from "../../lib/hooks";
import { useCloseOnScroll } from "./popupScroll";

const EDGE = 8;
const GAP = 6;
const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
const openStack: HTMLDivElement[] = [];

/**
 * A small non-modal panel anchored to the control that opened it (problems list, pending comments).
 * Opens above or below the anchor (flipping to fit), aligned to its start or end edge; focus moves in
 * on open and back to the anchor on close; Tab and Shift+Tab cycle inside it (decision 95, `popupNav`); Esc, a click outside,
 * focus moved elsewhere or a scroll that moves the anchor (`popupScroll`) closes it.
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
  /** Gap to the anchor (default 6; a composer chip's picker sits 4px from it, decision 56). */
  gap?: number;
  className?: string;
  children: ReactNode;
}) {
  const { anchor, onClose, side = "bottom", align = "start", gap = GAP } = props;
  const edge = useLatest(props.edge);
  const ref = useRef<HTMLDivElement>(null);
  const state = usePresence();
  const open = state === "open";
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    const a = anchor.current;
    if (!el || !a) return;
    const place = () => {
      const r = a.getBoundingClientRect();
      const v = edge.current?.()?.getBoundingClientRect() ?? r;
      // Layout size, not the painted box: the entry animation scales the panel, which would misplace it (a 1px overlap
      // with its chip, decision 56).
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const roomAbove = v.top - gap - EDGE;
      const roomBelow = window.innerHeight - v.bottom - gap - EDGE;
      const up = side === "top" ? height <= roomAbove || roomAbove > roomBelow : height > roomBelow && roomAbove > roomBelow;
      const left = Math.min(Math.max(EDGE, align === "start" ? r.left : r.right - width), window.innerWidth - width - EDGE);
      const top = up ? Math.max(EDGE, v.top - gap - height) : Math.min(v.bottom + gap, window.innerHeight - height - EDGE);
      const origin = `${align === "start" ? "0%" : "100%"} ${up ? "100%" : "0%"}`;
      setPos((prev) => (prev && prev.left === left && prev.top === top && prev.origin === origin ? prev : { left, top, origin }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, anchor, side, align, edge, gap]);

  // Decision 56: while a popover of the composer is open, the "Jump to latest" button hides (it would sit under it).
  useEffect(() => {
    if (!anchor.current?.closest("[data-composer]")) return;
    const root = document.documentElement;
    root.dataset.composerPopover = "";
    return () => {
      delete root.dataset.composerPopover;
    };
  }, [anchor]);

  // Decision 95 b: focus lands where the arrow keys work. The field a popover marks `data-autofocus` wins, then any text
  // field (a `SearchField` does not carry the mark: the first *button* used to win, so keys did nothing until a click), then
  // a button, then the panel itself.
  useEffect(() => {
    const el = ref.current;
    const opener = anchor.current;
    const first =
      el?.querySelector<HTMLElement>("[data-autofocus]") ??
      el?.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), [role='combobox']") ??
      el?.querySelector<HTMLElement>("button:not(:disabled), [tabindex='0']");
    (first ?? el)?.focus({ preventScroll: true });
    return () => {
      // Unmounted with focus lost to the page (no exit animation): the opener takes it back.
      const a = document.activeElement;
      if (opener?.isConnected && (!a || a === document.body)) opener.focus({ preventScroll: true });
    };
  }, [anchor]);

  // Back to the opener the moment the exit starts (the panel goes inert, which would drop focus to the page), and when it unmounts.
  useEffect(() => {
    if (open) return;
    const a = document.activeElement;
    const opener = anchor.current;
    // Only while focus is still in the panel or lost: a dialog that the choice opened keeps it.
    if (opener?.isConnected && (!a || a === document.body || ref.current?.contains(a))) opener.focus({ preventScroll: true });
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (el) openStack.push(el);
    const isTop = () => openStack.length === 0 || openStack[openStack.length - 1] === el;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (el?.contains(t) || anchor.current?.contains(t)) return;
      const idx = el ? openStack.indexOf(el) : -1;
      if (idx >= 0 && openStack.slice(idx + 1).some((child) => child.contains(t))) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Tab") return cycle(e);
      if (e.key !== "Escape" || !isTop()) return;
      e.preventDefault();
      e.stopPropagation();
      anchor.current?.focus({ preventScroll: true });
      onClose();
    };
    // Decision 95 (`popupNav`): Tab and Shift+Tab cycle through the panel's focusable elements; focus never leaves it while open.
    // Only while focus is in this panel: a popup opened from it (a `Select`'s list) is portalled outside and cycles its own.
    const cycle = (e: KeyboardEvent) => {
      if (!el || !(document.activeElement instanceof Node) || !el.contains(document.activeElement)) return;
      const nodes = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.tabIndex >= 0 && n.offsetParent !== null);
      e.preventDefault();
      if (nodes.length === 0) return;
      const at = nodes.findIndex((n) => n === document.activeElement);
      const next = at < 0 ? (e.shiftKey ? nodes.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
      nodes[next]?.focus({ preventScroll: true });
    };
    // Focus that leaves anyway (a programmatic focus elsewhere) closes it. A move to nothing (the window lost focus, a row
    // re-rendered) and a move into another popup layer (a `Select` or `Menu` opened from this panel) do not.
    const left = (e: FocusEvent) => {
      const to = e.relatedTarget;
      if (!(to instanceof Element) || el?.contains(to) || anchor.current?.contains(to)) return;
      if (to.closest('[role="menu"],[role="listbox"],[role="dialog"]')) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    el?.addEventListener("focusout", left);
    window.addEventListener("resize", onClose);
    return () => {
      if (el) {
        const idx = openStack.lastIndexOf(el);
        if (idx >= 0) openStack.splice(idx, 1);
      }
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      el?.removeEventListener("focusout", left);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose, anchor]);

  // Only a scroll that moves the anchor closes it: a live transcript scrolling elsewhere must not (v6.3 part 2).
  useCloseOnScroll(open, ref, () => anchor.current, onClose);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      data-state={state}
      inert={!open}
      style={pos ? ({ left: pos.left, top: pos.top, "--octo-origin": pos.origin } as CSSProperties) : { left: 0, top: 0, visibility: "hidden" }}
      className={cn(
        "octo-overlay fixed z-[60] flex max-h-[min(420px,calc(100dvh-24px))] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl bg-overlay text-sm shadow-pop focus:outline-none focus-visible:shadow-pop forced-colors:border forced-colors:border-[CanvasText]",
        props.className,
      )}
    >
      {props.children}
    </div>,
    document.body,
  );
}
