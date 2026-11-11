import { lazy, Suspense, type ComponentProps } from "react";

const Markdown = lazy(() => import("../shared/Markdown").then((m) => ({ default: m.Markdown })));

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
