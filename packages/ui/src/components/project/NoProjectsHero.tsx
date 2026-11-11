import { Plus } from "lucide-react";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { StreakLayer } from "../primitives/StreakLayer";
import { STREAK_HERO } from "../../lib/streakPresets";

/** No projects yet: a centred title, one line and the one action, over the start-here streak. */
export function NoProjectsHero({ onCreate }: { onCreate(): void }) {
  const { theme, backdrop } = useApp();
  return (
    // Decision 50: the streak is fixed to the panel (outside the scroller); the content scrolls only when it must.
    <section aria-labelledby="hero-title" data-hero className="relative h-full overflow-hidden">
      {backdrop !== "off" && <StreakLayer preset={STREAK_HERO} theme={theme} mono={backdrop === "mono"} />}
      <div data-start-scroll className="relative grid h-full place-items-center overflow-x-hidden overflow-y-auto overscroll-none px-6">
        <div className="relative w-full max-w-[440px] text-center">
          {/* Decision 28: the lead-in muted, the statement in fg — one sentence. */}
          <h1 id="hero-title" className="relative text-display text-fg">
            <span className="octo-lead">No projects yet.</span> Create one to put an orchestrator to work.
          </h1>
          <p className="relative mt-2 text-sm text-fg-2">A project has its own orchestrator, folders and notes.</p>
          <Button variant="primary" icon={Plus} onClick={onCreate} className="relative mt-6">
            Create project
          </Button>
        </div>
      </div>
    </section>
  );
}
