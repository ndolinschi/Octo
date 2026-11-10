import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** First tooltip waits this long; while "warm" (another one closed recently) the next shows at once. */
const DELAY = 600;
const WARM_FOR = 400;
const GAP = 6;
const EDGE = 8;

type Tip = { text: string; shortcut: string | null; rect: DOMRect; side: "below" | "left" };

function disabled(el: Element): boolean {
  return el.matches(":disabled, [aria-disabled='true']");
}

/** Moves a native `title` into `data-tip` (so the browser's own tooltip never doubles ours). */
function tipOf(el: HTMLElement): string | null {
  const title = el.getAttribute("title");
  if (title) {
    el.dataset.tip = title;
    el.removeAttribute("title");
  }
  return el.dataset.tip ?? null;
}

/**
 * One tooltip layer for the whole app, driven by the `title` attribute every control already has
 * (plus `data-shortcut` for a keyboard hint, `data-tip-side="left"` to sit beside it). Appears after 600ms, instantly for neighbours while
 * warm; never on disabled controls; hides on press, key, scroll or leave. Text alternatives stay
 * in aria-label / visible text; the tooltip is visual only.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    let warmUntil = 0;
    const pointer = { x: 0, y: 0 };
    const track = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (current) warmUntil = Date.now() + WARM_FOR;
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      track(e);
      const el = (e.target as Element | null)?.closest<HTMLElement>("[title], [data-tip]");
      if (el === current) return;
      if (!el) return hide();
      window.clearTimeout(timer);
      if (current) warmUntil = Date.now() + WARM_FOR;
      current = el;
      setTip(null);
      const text = tipOf(el);
      if (!text || disabled(el)) return;
      const show = () => {
        if (current !== el || !el.isConnected) return;
        // Tall targets (dividers, rows of text) anchor at the pointer rather than their whole box.
        const box = el.getBoundingClientRect();
        const rect = box.height > 48 ? new DOMRect(pointer.x - 1, pointer.y - 8, 2, 16) : box;
        setTip({ text, shortcut: el.dataset.shortcut ?? null, rect, side: el.dataset.tipSide === "left" ? "left" : "below" });
      };
      if (Date.now() < warmUntil) show();
      else timer = window.setTimeout(show, DELAY);
    };
    const leaveWindow = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    document.addEventListener("pointermove", track, true);
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", leaveWindow, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointermove", track, true);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", leaveWindow, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Below the control, centred and kept in the viewport; above it when there is no room below.
  // `data-tip-side="left"` (controls over content, like the editor's comment button): to the left,
  // vertically centred; above when there is no room on the left.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return setPos(null);
    const { width, height } = el.getBoundingClientRect();
    const r = tip.rect;
    if (tip.side === "left") {
      const left = r.left - GAP - width;
      return setPos(
        left >= EDGE
          ? { left: Math.round(left), top: Math.round(r.top + r.height / 2 - height / 2) }
          : { left: Math.round(Math.max(EDGE, r.left + r.width / 2 - width / 2)), top: Math.round(r.top - GAP - height) },
      );
    }
    const below = r.bottom + GAP + height + EDGE <= window.innerHeight;
    setPos({
      left: Math.round(Math.min(window.innerWidth - width - EDGE, Math.max(EDGE, r.left + r.width / 2 - width / 2))),
      top: Math.round(below ? r.bottom + GAP : r.top - GAP - height),
    });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      aria-hidden
      data-tooltip=""
      style={pos ?? { left: -9999, top: -9999 }}
      className="pointer-events-none fixed z-[80] flex max-w-[360px] items-center gap-2 rounded-sm border border-transparent bg-overlay px-2 py-1 text-xs text-fg shadow-pop"
    >
      <span className="min-w-0 wrap-anywhere">{tip.text}</span>
      {tip.shortcut && <kbd className="shrink-0 rounded-2xs bg-active px-1 font-sans text-xs text-fg-2">{tip.shortcut}</kbd>}
    </div>,
    document.body,
  );
}
