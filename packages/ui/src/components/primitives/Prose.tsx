import "./Prose.css";
import { cn } from "../../lib/cn";

export type ProseSize = "compact" | "reading";

/**
 * The class of a block of rendered Markdown (decision 93 g), built once.
 *
 * - `reading`: the conversation's own scale (14/22, second-level headings 16): `octo-prose`, unchanged.
 * - `compact`: for a pane (Memory, Notes, review threads, the side question): body 13/20, headings of every level 13
 *   semibold with 12px above and 4 below, tight lists, code 12, tables that scroll inside their frame. It never exceeds
 *   the type size of the pane's own title.
 *
 * The renderer itself (a lazy chunk) lives in `shared/Prose`, which composes this class; primitives cannot import it.
 * Not for: a document preview (`octo-doc`), a single line of text.
 */
export function proseClass(size: ProseSize = "reading", extra?: string): string {
  return cn("octo-prose", size === "compact" && "octo-prose-compact", extra);
}

/** The text as plain paragraphs with the same metrics, shown until the Markdown chunk arrives (no layout jump). */
export function ProseFallback({ text, size }: { text: string; size: ProseSize }) {
  return (
    <div className={proseClass(size)}>
      <p className="whitespace-pre-wrap">{text}</p>
    </div>
  );
}
