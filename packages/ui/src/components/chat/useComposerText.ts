import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DraftBus } from "./draftBus";

/** Decision 62: the text area grows from 1 to 10 lines, then scrolls. Mirrors `.octo-composer-input`'s line height. */
export const COMPOSER_LINE = 22;
export const COMPOSER_MAX_LINES = 10;

export type ComposerDraft = DraftBus;

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
    if (!el) return;
    el.style.height = "0px";
    const max = COMPOSER_LINE * COMPOSER_MAX_LINES;
    el.style.height = `${Math.max(COMPOSER_LINE, Math.min(el.scrollHeight, max))}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, []);
  useLayoutEffect(fit, [text, fit]);
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver === "undefined") return;
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
