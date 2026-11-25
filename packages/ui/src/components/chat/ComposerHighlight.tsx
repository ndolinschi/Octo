import { memo, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { composerSpans, hasHighlights, type HighlightKind } from "../../lib/mentions";
import { highlightable } from "../../lib/composerInput";
import { useOptionalCode } from "../../state/code";

const KIND_CLASS: Record<HighlightKind, string> = {
  mention: "octo-mention",
  command: "octo-command",
  "md-heading": "octo-md-heading",
  "md-tag": "octo-md-tag",
  "md-code": "octo-md-code",
  "md-quote": "octo-md-quote",
  "md-list": "octo-md-list",
  "md-link": "octo-md-link",
  "md-strong": "octo-md-strong",
  "md-em": "octo-md-em",
};

/**
 * Decision 70: the layer under the composer's text area that colors `@file` mentions, `/commands`, and Markdown syntax.
 * It repeats the same characters in the same box (same font, wrapping, padding, scroll position) with metric-safe color/tint
 * only: nothing moves, so the caret, selection, IME composition and undo stay the browser's own, and typing never shifts a line.
 */
export const ComposerHighlight = memo(function ComposerHighlight({
  text,
  area,
  commands,
  onActiveChange,
}: {
  text: string;
  area: RefObject<HTMLTextAreaElement | null>;
  commands?: readonly string[] | undefined;
  onActiveChange?(active: boolean): void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const code = useOptionalCode();
  const knownFiles = useMemo(() => {
    const files = code?.loadedFiles;
    if (!files?.length) return undefined;
    const counts = new Map<string, number>();
    for (const f of files) {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1);
      if (!name.includes(".")) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const unique = new Set<string>();
    for (const [name, count] of counts) if (count === 1) unique.add(name);
    return unique.size > 0 ? unique : undefined;
  }, [code?.loadedFiles]);

  // P1-5: only a text with something to color is mirrored, and never a huge one (`highlightable`): the mirror's layout was the
  // seconds-long freeze on a pasted log.
  const spans = useMemo(() => {
    if (!highlightable(text)) return null;
    const all = composerSpans(text, commands, knownFiles ? { knownFiles } : undefined);
    return hasHighlights(all) ? all : null;
  }, [text, commands, knownFiles]);

  const active = spans !== null;
  useLayoutEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);

  // Both boxes reserve the scrollbar's width (`scrollbar-gutter: stable` on `.octo-composer-input`), so wrapping matches; the layer only follows the scroll.
  useLayoutEffect(() => {
    if (!active) return;
    const ta = area.current;
    const el = layer.current;
    if (!ta || !el) return;
    const sync = () => {
      el.scrollTop = ta.scrollTop;
      el.scrollLeft = ta.scrollLeft;
    };
    sync();
    ta.addEventListener("scroll", sync, { passive: true });
    return () => ta.removeEventListener("scroll", sync);
  }, [area, active]);

  if (!spans) return null;

  return (
    <div
      ref={layer}
      aria-hidden
      data-composer-highlight
      className="octo-composer-input pointer-events-none absolute inset-0 overflow-x-hidden overflow-y-auto px-3 wrap-anywhere whitespace-pre-wrap text-fg"
    >
      {spans.map((s, i) =>
        s.kind === "text" ? (
          s.text
        ) : (
          <mark key={i} data-kind={s.kind} className={KIND_CLASS[s.kind]}>
            {s.text}
          </mark>
        ),
      )}
      {/* A trailing newline needs a character to take its line, as in the text area. */}
      {text.endsWith("\n") ? "​" : null}
    </div>
  );
});
