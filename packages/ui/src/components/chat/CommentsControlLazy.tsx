import { lazy, Suspense, type ComponentProps } from "react";

const Control = lazy(() => import("./CommentsControl").then((m) => ({ default: m.CommentsControl })));

/** The pending-comments control loads with the first pending comment (its own chunk). */
export function CommentsControl(props: ComponentProps<typeof Control>) {
  return (
    <Suspense fallback={null}>
      <Control {...props} />
    </Suspense>
  );
}
