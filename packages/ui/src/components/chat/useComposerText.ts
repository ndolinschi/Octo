import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Decision 62: the text area grows from 1 to 10 lines, then scrolls. Mirrors `.octo-composer-input`'s line height. */
export const COMPOSER_LINE = 22;
export const COMPOSER_MAX_LINES = 10;

export type ComposerDraft = { initial: string; save(text: string): void; subscribe?(cb: (text: string) => void): () => void };

/**
 * The composer's text: kept in the shared draft (both composers on one key hear each other), and the text area's
 * height fitted to it (refitted when the width changes the wrapping).
 */
export function useComposerText(draft: ComposerDraft | undefined) {
  const [text, setText] = useState(() => draft?.initial ?? "");
  const area = useRef<HTMLTextAreaElement>(null);
  const save = draft?.save;
  useEffect(() => {
    save?.(text);
  }, [text, save]);
  const subscribe = draft?.subscribe;
  useEffect(() => subscribe?.((t) => setText((cur) => (cur === t ? cur : t))), [subscribe]);

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
