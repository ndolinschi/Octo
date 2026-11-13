import { useMemo, useState } from "react";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { cn } from "../../lib/cn";
import { useNow } from "../../lib/hooks";
import type { GlyphState } from "../../lib/stateGlyph";
import { STREAK_BAND } from "../../lib/streakPresets";
import { TRIAGE_LABEL, TRIAGE_ORDER, triageOf, type Triage } from "../../lib/triage";
import { useApp } from "../../state/app";
import { Card } from "../primitives/Card";
import { ListRow } from "../primitives/ListRow";
import { StateGlyph } from "../primitives/StateGlyph";
import { StreakLayer } from "../primitives/StreakLayer";
import { TeamCard } from "./HomeCards";
import { Projects } from "./HomeProjects";
import { STILL } from "./still";
import { useOverview } from "./useOverview";

/**
 * Home (`#/`, decisions 22, 23, 75, 91a): projects and their orchestrators, not requests. The streak is a band at the top
 * (a spacer of its height keeps the content out of it), then the title, the state tiles that filter the list, the project
 * list (needs you, working, then the rest) and "Agents at work" while an agent runs. Nothing here only reports a number
 * (decision 75); numbers live in Usage.
 */
export function Home({ onNewProject, onSearch, unseen }: { onNewProject(): void; onSearch(): void; unseen: Set<string> }) {
  const { theme, backdrop } = useApp();
  const data = useOverview();
  const now = useNow(true, CLOCK_MINUTE_MS);
  const [filter, setFilter] = useState<Triage | null>(null);
  const triaged = useMemo(
    () =>
      (data.projects ?? []).map((p) => {
        const s = data.orchestrators.get(p.id) ?? ({ kind: "idle", at: p.updated_at } as const);
        return { project: p, state: s, triage: triageOf(s, unseen.has(p.id)) };
      }),
    [data.projects, data.orchestrators, unseen],
  );
  const count = data.projects?.length ?? 0;
  return (
    // Decision 50: the streak is fixed to the panel (outside the scroller); only the content scrolls, never rubber-bands.
    <section aria-labelledby="home-title" data-home className="@container/home relative flex h-full flex-col overflow-hidden">
      {backdrop !== "off" && <StreakLayer preset={STREAK_BAND} theme={theme} mono={backdrop === "mono"} />}
      <div aria-hidden className={cn("shrink-0", backdrop === "off" ? "h-6" : "h-(--octo-band-h)")} />
      <div data-home-scroll data-start-scroll className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
        <div className="mx-auto flex w-full max-w-home flex-col gap-4 px-6 pt-2 pb-8 max-sm:px-4">
          <div className="flex flex-col gap-3">
            {/* Decision 28: one sentence in two tones — the lead-in muted, the statement in fg. */}
            <h1 id="home-title" className="text-center text-display text-fg">
              {count > 0 && <span className="octo-lead">{count === 1 ? "One project. " : `${count} projects. `}</span>}
              What should we work on?
            </h1>
            <TriageRow items={triaged} loading={data.projects === null} value={filter} onChange={setFilter} />
          </div>
          <Projects items={triaged} data={data} now={now} filter={filter} onNewProject={onNewProject} onSearch={onSearch} />
          <TeamCard projects={data.projects} agents={data.agents} />
        </div>
      </div>
    </section>
  );
}

const TRIAGE_GLYPH: Record<Triage, GlyphState> = { needs: "needs", working: "working", review: "unseen", idle: "idle" };

/**
 * Decision 26's triage row: four one-row `Card` tiles (two rows of two under 640px) — Needs you, Working, Ready to review,
 * Idle — each a toggle that filters the project list (one at a time; again to clear). A zero tile stays, quiet. The glyphs
 * are still (decision 76): a tile counts projects, it is not itself working.
 */
function TriageRow(props: { items: { triage: Triage }[]; loading: boolean; value: Triage | null; onChange(t: Triage | null): void }) {
  return (
    <div role="group" aria-label="Filter projects by state" className="grid grid-cols-4 gap-2 @max-[640px]/home:grid-cols-2">
      {TRIAGE_ORDER.map((t) => {
        const n = props.items.filter((x) => x.triage === t).length;
        const on = props.value === t;
        return (
          <div key={t} data-triage={t} className="min-w-0">
            <Card padding="none">
              <ListRow
                size="lg"
                selected={on}
                onClick={() => props.onChange(on ? null : t)}
                leading={<StateGlyph state={TRIAGE_GLYPH[t]} size={14} box={16} className={STILL} />}
                title={TRIAGE_LABEL[t]}
                meta={<span className={cn("tabular-nums", props.loading || n === 0 ? "text-fg-3" : "text-fg")}>{props.loading ? "–" : n}</span>}
                tip={`${TRIAGE_LABEL[t]}: ${props.loading ? "loading" : n}`}
              />
            </Card>
          </div>
        );
      })}
    </div>
  );
}
