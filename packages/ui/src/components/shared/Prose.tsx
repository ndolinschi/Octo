import { lazy, Suspense } from "react";
import { ProseFallback, proseClass, type ProseSize } from "../primitives/Prose";

const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

/**
 * Markdown at one of the two prose scales (decision 93 g): `compact` in a pane, `reading` in the conversation. Wraps the
 * existing lazy renderer; the first paint shows the text plain with the same metrics.
 */
export function Prose(props: { text: string; size?: ProseSize; className?: string }) {
  const size = props.size ?? "reading";
  return (
    <Suspense fallback={<ProseFallback text={props.text} size={size} />}>
      <Markdown text={props.text} className={proseClass(size, props.className)} />
    </Suspense>
  );
}
