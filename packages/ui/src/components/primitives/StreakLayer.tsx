import { lazy, Suspense } from "react";
import type { StreakPreset } from "../../lib/streakPresets";

const Streak = lazy(() => import("./Streak"));

/**
 * The start screens' backdrop (decision 21): the dithered streak behind everything in its positioned parent.
 * The canvas code loads on first use (its own chunk); until then, and if it fails, the panel stays plain.
 * Pass one of the presets of `lib/streakPresets.ts`.
 */
export function StreakLayer({
  preset,
  theme,
  mono = false,
}: {
  preset: StreakPreset;
  theme: "dark" | "light";
  /** Decision 31's Mono backdrop. */ mono?: boolean;
}) {
  return (
    <div aria-hidden className="octo-streak-layer pointer-events-none absolute inset-0 overflow-hidden">
      <Suspense fallback={null}>
        <Streak preset={preset} theme={theme} mono={mono} />
      </Suspense>
    </div>
  );
}
