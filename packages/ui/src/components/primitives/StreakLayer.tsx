import { lazy, Suspense } from "react";
import type { StreakPreset } from "../../lib/streakPresets";

const Streak = lazy(() => import("./Streak"));

/**
 * The start screens' backdrop (decisions 21, 91a): the dithered streak as a band across the top of its positioned parent,
 * `--octo-band-h` tall, faded at its lower edge. The screen leaves that band free of content (Home and the connect screen
 * put a spacer of the same height above their scroller; the empty conversation's text starts below it), so nothing ever
 * sits on the streak and no scrim is needed. `data-streak-band` marks the box for the backdrop check.
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
    <div aria-hidden data-streak-band className="octo-streak-layer pointer-events-none absolute inset-x-0 top-0 overflow-hidden">
      <Suspense fallback={null}>
        <Streak preset={preset} theme={theme} mono={mono} />
      </Suspense>
    </div>
  );
}
