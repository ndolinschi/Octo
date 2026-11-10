import { lazy, Suspense } from "react";
import type { StreakAnchor } from "../../lib/streak";

const Streak = lazy(() => import("./Streak"));

/**
 * The start screens' backdrop (decision 21): the dithered streak behind everything in its positioned parent.
 * The canvas code loads on first use (its own chunk); until then, and if it fails, the panel stays plain.
 * Use a module-level constant for `anchor`.
 */
export function StreakLayer({ anchor, theme }: { anchor: StreakAnchor; theme: "dark" | "light" }) {
  return (
    <div aria-hidden className="octo-streak-layer pointer-events-none absolute inset-0 overflow-hidden">
      <Suspense fallback={null}>
        <Streak anchor={anchor} theme={theme} />
      </Suspense>
    </div>
  );
}
