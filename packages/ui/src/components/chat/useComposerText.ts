import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DraftBus } from "./draftBus";

/** Decision 62: the text area grows from 1 to 10 lines, then scrolls. Mirrors `.octo-composer-input`'s line height. */
export const COMPOSER_LINE = 22;
export const COMPOSER_MAX_LINES = 10;

export type ComposerDraft = DraftBus;

const px = (v: string): number => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

/**
 * The text area's height where the engine does not size it (no `field-sizing`: Safari before 26): its content height,
 * at least one line (or the CSS min-height), at most ten lines and never past the CSS max-height (the phone caps the
 * field at min(120px, 20% of the visible height)). Computed-style strings in, px out.
 */
export function fitHeight(scrollHeight: number, lineHeight: string, minHeight: string, maxHeight: string): number {
  const line = px(lineHeight) || COMPOSER_LINE;
  const min = Math.max(line, px(minHeight) || 0);
  const cssMax = px(maxHeight);
  const max = Math.max(min, Number.isNaN(cssMax) ? line * COMPOSER_MAX_LINES : Math.min(cssMax, line * COMPOSER_MAX_LINES));
  return Math.max(min, Math.min(scrollHeight, max));
}

/**
 * P1-5: where the engine sizes a text area to its content (`field-sizing: content`, styles.css "stress: perf"), the height
 * is left to it; measuring (height 0, then scrollHeight) laid a pasted megabyte out twice per keystroke.
 */
const SIZED_BY_CSS = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

/**
 * The composer's text: kept in the shared draft (both composers on one key hear each other), and the text area's
 * height fitted to it (refitted when the width changes the wrapping).
 */
export function useComposerText(draft: ComposerDraft | undefined) {
  const [text, setTextState] = useState(() => draft?.value ?? "");
  const area = useRef<HTMLTextAreaElement>(null);
  const member = useRef<ReturnType<DraftBus["join"]> | null>(null);
  useEffect(() => {
    if (!draft) return;
    const joined = draft.join((heard) => setTextState(heard));
    member.current = joined;
    // The other composer may have been typed in between the first render and this effect.
    setTextState((cur) => (cur === draft.value ? cur : draft.value));
    return () => {
      joined.leave();
      member.current = null;
    };
  }, [draft]);
  // Saved from the event that changes the text, not from an effect: nothing is set in a commit after a keystroke.
  const setText = useCallback((value: string) => {
    setTextState(value);
    member.current?.save(value);
  }, []);

  const fit = useCallback(() => {
    const el = area.current;
    if (!el || SIZED_BY_CSS) return;
    el.style.height = "0px";
    const cs = getComputedStyle(el);
    el.style.height = `${fitHeight(el.scrollHeight, cs.lineHeight, cs.minHeight, cs.maxHeight)}px`;
    // Scrolls once the text is taller than the box it got (the phone caps it lower than ten lines: CSS max-height).
    el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? "auto" : "hidden";
  }, []);
  useLayoutEffect(fit, [text, fit]);
  useEffect(() => {
    const el = area.current;
    if (!el || SIZED_BY_CSS || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  /** Replaces the text and puts the caret at `caret` (default: the end) once it is rendered. */
  const place = useCallback((value: string, caret = value.length) => {
    setText(value);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(caret, caret);
    });
  }, []);

  return { text, setText, area, place };
}
