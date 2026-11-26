import { Plus } from "lucide-react";
import { cn } from "../../lib/cn";
import { STREAK_BAND } from "../../lib/streakPresets";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { StreakLayer } from "../primitives/StreakLayer";

/** No projects yet: the streak band, then a centred title, one line and the one action (decision 91a: nothing on the band). */
export function NoProjectsHero({ onCreate }: { onCreate(): void }) {
  const { theme, backdrop } = useApp();
  return (
    // Decision 50: the streak is fixed to the panel (outside the scroller); the content scrolls only when it must.
    <section aria-labelledby="hero-title" data-hero className="relative flex h-full flex-col overflow-hidden">
      {backdrop !== "off" && <StreakLayer preset={STREAK_BAND} theme={theme} mono={backdrop === "mono"} />}
      <div aria-hidden className={cn("shrink-0", backdrop === "off" ? "h-0" : "h-(--octo-band-h)")} />
      <div data-start-scroll className="relative grid min-h-0 flex-1 place-items-center overflow-x-hidden overflow-y-auto overscroll-none px-6">
        <div className="w-full max-w-[440px] pb-8 text-center">
          {/* Decision 28: the lead-in muted, the statement in fg — one sentence. */}
          <h1 id="hero-title" className="text-display text-balance text-fg">
            <span className="octo-lead">No projects yet.</span> Create one to get started.
          </h1>
          <p className="mt-2 text-sm text-pretty text-fg-2">A project has its own conversation, folders and notes.</p>
          <Button variant="primary" icon={Plus} onClick={onCreate} className="mt-6">
            Create project
          </Button>
        </div>
      </div>
    </section>
  );
}
