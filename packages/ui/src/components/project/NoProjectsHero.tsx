import { Plus } from "lucide-react";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { StreakLayer } from "../primitives/StreakLayer";
import { STREAK_HERO } from "../../lib/streakPresets";

/** No projects yet: a centred title, one line and the one action, over the start-here streak. */
export function NoProjectsHero({ onCreate }: { onCreate(): void }) {
  const { theme } = useApp();
  return (
    <section aria-labelledby="hero-title" className="relative grid h-full place-items-center overflow-x-hidden overflow-y-auto px-6">
      <StreakLayer preset={STREAK_HERO} theme={theme} />
      <div className="relative w-full max-w-[440px] text-center">
        <div aria-hidden className="octo-streak-scrim" />
        <h1 id="hero-title" className="relative text-display text-fg">
          No projects yet
        </h1>
        <p className="relative mt-2 text-sm text-fg-2">A project has its own orchestrator, folders and notes.</p>
        <Button variant="primary" icon={Plus} onClick={onCreate} className="relative mt-6">
          Create project
        </Button>
      </div>
    </section>
  );
}
