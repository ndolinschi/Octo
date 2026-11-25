import { useEffect, type RefObject } from "react";

/** The attribute that hides the focus ring of an element focused by the app, not by the person (styles.css). */
export const QUIET_FOCUS_ATTR = "data-quiet-focus";

type Focusable = Pick<HTMLElement, "focus" | "setAttribute" | "removeAttribute" | "addEventListener" | "removeEventListener">;

/**
 * Polish pass F3 (B4.3, B2): focus that the app moves by itself (a panel opening from the palette, a search field when a list
 * opens) lands without the ring: the browser counts it as keyboard focus after Ctrl+K and drew a bright ring around a field
 * nobody had reached yet. The first key pressed there, or leaving it, brings the ring back for the rest of the way.
 */
export function quietFocus(el: Focusable | null | undefined, options: { preventScroll?: boolean } = {}): void {
  if (!el) return;
  el.setAttribute(QUIET_FOCUS_ATTR, "");
  const clear = () => {
    el.removeAttribute(QUIET_FOCUS_ATTR);
    el.removeEventListener("keydown", clear);
    el.removeEventListener("blur", clear);
  };
  el.addEventListener("keydown", clear);
  el.addEventListener("blur", clear);
  el.focus({ preventScroll: options.preventScroll ?? true });
}

/**
 * 7g: the approvals that already took focus once in this window (a card takes quiet focus as it appears): a card that mounts
 * again (a moved tab) does not take it again. R2: one module for quiet focus (it was `lib/v7/quietFocus.ts` too).
 */
export const FOCUSED_ONCE = new Set<string>();

/** The attribute on a panel root whose programmatic focus draws no ring until the first key or press inside it. */
export const QUIET_ROOT_ATTR = "data-quiet-root";

type Target = Pick<HTMLElement, "addEventListener" | "removeEventListener">;
type Root = Target & Pick<HTMLElement, "setAttribute" | "removeAttribute" | "contains">;

/**
 * B4.3 (polish pass F3): a panel that just opened (from the palette, a header button) gets its first field or row focused by
 * the dock; the browser counts that as keyboard focus and drew a bright ring on something nobody reached yet. The root is
 * quiet while focus arrives from outside by any way but Tab (mounted, or focused again from the palette), until the first
 * key (a Tab then shows the ring where it lands) or press inside. Returns the cleanup.
 */
export function quietUntilInput(root: Root | null | undefined, win: Target | undefined = typeof window === "undefined" ? undefined : window): () => void {
  if (!root) return () => undefined;
  let lastKey = "";
  const arm = () => root.setAttribute(QUIET_ROOT_ATTR, "");
  const clear = () => root.removeAttribute(QUIET_ROOT_ATTR);
  const onKey = (e: Event) => {
    lastKey = "key" in e && typeof e.key === "string" ? e.key : "";
  };
  const onFocusIn = (e: Event) => {
    const from = "relatedTarget" in e && typeof Node !== "undefined" && e.relatedTarget instanceof Node ? e.relatedTarget : null;
    const outside = from === null || !root.contains(from);
    if (outside && lastKey !== "Tab") arm();
  };
  arm();
  root.addEventListener("keydown", clear, true);
  root.addEventListener("pointerdown", clear, true);
  root.addEventListener("focusin", onFocusIn);
  win?.addEventListener("keydown", onKey, true);
  return () => {
    clear();
    root.removeEventListener("keydown", clear, true);
    root.removeEventListener("pointerdown", clear, true);
    root.removeEventListener("focusin", onFocusIn);
    win?.removeEventListener("keydown", onKey, true);
  };
}

/** `quietUntilInput` on a panel's root element for as long as the panel is mounted. */
export function useQuietOpen(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => quietUntilInput(ref.current), [ref]);
}
