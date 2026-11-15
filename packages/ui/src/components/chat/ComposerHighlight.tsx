import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { composerSpans, hasHighlights } from "../../lib/mentions";
import { highlightable } from "../../lib/composerInput";

/**
 * Decision 70: the layer under the composer's text area that tints `@file` mentions and `/commands`. It repeats the same
 * characters in the same box (same font, wrapping, padding, scroll position) with transparent ink, so only the tint shows and
 * nothing moves: the caret, selection, IME composition and undo stay the browser's own, and typing never shifts a line.
 */
export function ComposerHighlight({ text, area }: { text: string; area: RefObject<HTMLTextAreaElement | null> }) {
  const layer = useRef<HTMLDivElement>(null);
  // P1-5: only a text with something to tint is mirrored, and never a huge one (`highlightable`): the mirror's layout was the
  // seconds-long freeze on a pasted log.
  const spans = useMemo(() => {
    if (!highlightable(text)) return null;
    const all = composerSpans(text);
    return hasHighlights(all) ? all : null;
  }, [text]);

  // Both boxes reserve the scrollbar's width (`scrollbar-gutter: stable` on `.octo-composer-input`), so wrapping matches; the layer only follows the scroll.
  useLayoutEffect(() => {
    const ta = area.current;
    const el = layer.current;
    if (!ta || !el) return;
    const sync = () => {
      el.scrollTop = ta.scrollTop;
    };
    sync();
    ta.addEventListener("scroll", sync);
    return () => ta.removeEventListener("scroll", sync);
  }, [area, text]);

  return (
    <div
      ref={layer}
      aria-hidden
      data-composer-highlight
      className="octo-composer-input pointer-events-none absolute inset-x-0 top-3 bottom-2 overflow-hidden px-3 wrap-anywhere whitespace-pre-wrap text-transparent"
    >
      {spans?.map((s, i) =>
        s.kind === "text" ? (
          s.text
        ) : (
          <mark key={i} data-kind={s.kind} className={s.kind === "mention" ? "octo-mention" : "octo-command"}>
            {s.text}
          </mark>
        ),
      )}
      {/* A trailing newline needs a character to take its line, as in the text area. */}
      {spans && text.endsWith("\n") ? "​" : null}
    </div>
  );
}
