import type { ReactNode } from "react";

/** The matched part of a name in `fg` on the `mark` tint, a highlighter that reads on any row, chosen or not (no weight change; B33). */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-2xs bg-mark text-fg">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
