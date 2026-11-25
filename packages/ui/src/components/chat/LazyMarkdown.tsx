import { Suspense, type ComponentProps } from "react";
import { readyLazy } from "../../lib/readyLazy";

/** The Markdown renderer's chunk; once it is in, a reply renders without suspending (see `readyLazy`). */
export const markdownPart = readyLazy(() => import("../shared/Markdown").then((m) => m.Markdown));
const Markdown = markdownPart.Component;

type Props = ComponentProps<typeof Markdown>;

/** The Markdown renderer arrives in its own chunk; until then the text shows as it is, so first paint never waits for it. */
export function LazyMarkdown(props: Props) {
  return (
    <Suspense
      fallback={
        <div className={props.className}>
          <p className="whitespace-pre-wrap">{props.text}</p>
        </div>
      }
    >
      <Markdown {...props} />
    </Suspense>
  );
}
