import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** First tooltip waits this long; while "warm" (another one closed recently) the next shows at once. */
const DELAY = 600;
const WARM_FOR = 400;
const GAP = 6;
const EDGE = 8;
/** Focus that follows a navigation key within this time is the person's own; later focus is the app's. */
const NAV_FOCUS_MS = 500;

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
    // After a press, nothing shows until the pointer really moves: a click that changes the layout must not
    // pop the tooltip of whatever slid under the pointer.
    let pressedAt: { x: number; y: number } | null = null;
    const track = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      if (pressedAt && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 4) pressedAt = null;
    };
    const press = (e: PointerEvent) => {
      pressedAt = { x: e.clientX, y: e.clientY };
      hide();
    };
    // A control may change its `title` while its tooltip waits or shows (the budget reads its models on hover): follow it.
    const watch = new MutationObserver(() => {
      if (!current?.hasAttribute("title")) return;
      const text = tipOf(current);
      setTip((t) => (t && text ? { ...t, text } : t));
    });
    const hide = () => {
      window.clearTimeout(timer);
      watch.disconnect();
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
      if (pressedAt) return;
      arm(el);
    };
    // Keyboard focus shows the focused control's tooltip too (same delay and warmth); pointer focus does not. Only focus the
    // person moved (Tab, arrows, Home/End): a tab or dialog that puts focus on a row by itself shows no tooltip (B57).
    let navAt = 0;
    const NAV = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
    const key = (e: KeyboardEvent) => {
      if (NAV.has(e.key)) navAt = Date.now();
      hide();
    };
    const focusIn = (e: FocusEvent) => {
      if (document.documentElement.dataset.input !== "keyboard" || Date.now() - navAt > NAV_FOCUS_MS) return;
      const el = (e.target as Element | null)?.closest<HTMLElement>("[title], [data-tip]");
      if (!el || el === current) return;
      const box = el.getBoundingClientRect();
      pointer.x = box.left + box.width / 2;
      pointer.y = box.top + box.height / 2;
      arm(el);
    };
    const focusOut = (e: FocusEvent) => {
      if (current && current === e.target) hide();
    };
    const arm = (el: HTMLElement) => {
      window.clearTimeout(timer);
      watch.disconnect();
      watch.observe(el, { attributes: true, attributeFilter: ["title"] });
      if (current) warmUntil = Date.now() + WARM_FOR;
      current = el;
      setTip(null);
      const text = tipOf(el);
      if (!text || disabled(el)) return;
      const show = () => {
        if (current !== el || !el.isConnected) return;
        const now = tipOf(el) ?? text;
        // Tall targets (dividers, rows of text) anchor at the pointer rather than their whole box.
        const box = el.getBoundingClientRect();
        const rect = box.height > 48 ? new DOMRect(pointer.x - 1, pointer.y - 8, 2, 16) : box;
        setTip({ text: now, shortcut: el.dataset.shortcut ?? null, rect, side: el.dataset.tipSide === "left" ? "left" : "below" });
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
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("focusout", focusOut, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      watch.disconnect();
      document.removeEventListener("pointermove", track, true);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", leaveWindow, true);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("focusout", focusOut, true);
      document.removeEventListener("keydown", key, true);
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
      <span className="min-w-0 wrap-anywhere whitespace-pre-line">{tip.text}</span>
      {tip.shortcut && <kbd className="shrink-0 rounded-2xs bg-active px-1 font-sans text-xs text-fg-2">{tip.shortcut}</kbd>}
    </div>,
    document.body,
  );
}
